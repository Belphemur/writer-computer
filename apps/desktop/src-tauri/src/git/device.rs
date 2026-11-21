//! The device name the `Writer-Device:` trailer carries: the machine's host name.

/// The host name, `Unknown device` when the system gives none.
pub fn name() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is valid for its length and gethostname NUL-terminates within it.
        let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len() - 1) } == 0;
        if ok {
            let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            let host = String::from_utf8_lossy(&buf[..end]).trim().to_string();
            if !host.is_empty() {
                return host;
            }
        }
    }
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Unknown device".to_string())
}
