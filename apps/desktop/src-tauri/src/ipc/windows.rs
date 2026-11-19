//! The Windows endpoint: a named pipe reachable by the current user only (ADR 2026-11-18, point 1).
//!
//! Written without a Windows machine to run it on, and with no new crate: the handful of Win32
//! calls are declared here. What it does, in order: read the user's SID from the process token,
//! name the pipe after a hash of it, and create every pipe instance with the security descriptor
//! `D:P(A;;GA;;;<sid>)` (protected DACL: generic-all to that SID and to nobody else), remote
//! clients rejected and the first instance exclusive so another process cannot squat the name.
//! `cfg(windows)` only; it is compiled and exercised by no test on macOS or Linux.

use sha2::{Digest, Sha256};
use std::ffi::c_void;
use std::io;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(process: isize, access: u32, token: *mut isize) -> i32;
    fn GetTokenInformation(
        token: isize,
        class: u32,
        info: *mut c_void,
        len: u32,
        ret_len: *mut u32,
    ) -> i32;
    fn ConvertSidToStringSidW(sid: *mut c_void, out: *mut *mut u16) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl: *const u16,
        revision: u32,
        sd: *mut *mut c_void,
        size: *mut u32,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> isize;
    fn CloseHandle(handle: isize) -> i32;
    fn LocalFree(mem: *mut c_void) -> *mut c_void;
}

const TOKEN_QUERY: u32 = 0x0008;
const TOKEN_USER_CLASS: u32 = 1;
const SDDL_REVISION_1: u32 = 1;

#[repr(C)]
struct SecurityAttributes {
    length: u32,
    descriptor: *mut c_void,
    inherit_handle: i32,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The current user's SID as a string (`S-1-5-21-...`).
fn user_sid() -> io::Result<String> {
    // SAFETY: plain Win32 calls on pointers to locals we own; every handle and allocation made
    // here is released before returning.
    unsafe {
        let mut token: isize = 0;
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            let mut needed: u32 = 0;
            GetTokenInformation(
                token,
                TOKEN_USER_CLASS,
                std::ptr::null_mut(),
                0,
                &mut needed,
            );
            if needed == 0 {
                return Err(io::Error::last_os_error());
            }
            // 8-byte aligned storage: TOKEN_USER starts with a pointer.
            let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
            if GetTokenInformation(
                token,
                TOKEN_USER_CLASS,
                buf.as_mut_ptr().cast(),
                needed,
                &mut needed,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            // TOKEN_USER { SID_AND_ATTRIBUTES { Sid: PSID, Attributes: u32 } }: the SID is the
            // first field.
            let sid = *(buf.as_ptr() as *const *mut c_void);
            let mut text: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW(sid, &mut text) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut len = 0;
            while *text.add(len) != 0 {
                len += 1;
            }
            let s = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
            LocalFree(text.cast());
            Ok(s)
        })();
        CloseHandle(token);
        result
    }
}

/// `\\.\pipe\writer-<hash of the user SID>`: per user, so two users on one machine never share
/// or fight over a pipe. The same function names the pipe for the client.
pub fn pipe_name() -> io::Result<String> {
    let digest = Sha256::digest(user_sid()?.as_bytes());
    let hash: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Ok(format!(r"\\.\pipe\writer-{hash}"))
}

/// One pipe instance restricted to the current user. `first` makes it the exclusive first
/// instance of the name.
pub fn create_instance(name: &str, first: bool) -> io::Result<NamedPipeServer> {
    let sddl = wide(&format!("D:P(A;;GA;;;{})", user_sid()?));
    let mut descriptor: *mut c_void = std::ptr::null_mut();
    // SAFETY: `sddl` is NUL-terminated and outlives the call; `descriptor` receives a
    // LocalAlloc'd block that is freed below after the pipe is created (the kernel copies it).
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    };
    if converted == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut attributes = SecurityAttributes {
        length: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor,
        inherit_handle: 0,
    };
    // SAFETY: `attributes` is a valid SECURITY_ATTRIBUTES for the duration of the call.
    let created = unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                name,
                (&mut attributes as *mut SecurityAttributes).cast(),
            )
    };
    // SAFETY: `descriptor` came from the conversion above and is no longer used.
    unsafe { LocalFree(descriptor) };
    created
}
