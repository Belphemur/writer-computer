"""A fake model endpoint for the capture tools. Standard library only (run with `python3 -I`).

One tool shared by the OpenCode and the Claude captures: it speaks the OpenAI chat-completions wire
(`/v1/chat/completions`, `/v1/models`) and the Anthropic messages wire (`/v1/messages`), never calls a real
model, binds 127.0.0.1 only, and records what each request offered.

  python3 -I fake_model.py --record FILE [--port N | 0] [--call NAME --args JSON [--force]] [--reply TEXT] [--keep-body]

- `--record FILE` appends one JSON line per request: `{n, t, path, model, tools, tool_choice, stream, n_messages, fired, body?}`
  (`tools` is the list of tool names offered; `body` is dropped unless `--keep-body`). Bodies hold prompts, so
  they stay in the work folder; only the tool names and counts go into fixtures.
- `--call NAME --args JSON` makes the FIRST request that offers a tool whose name equals or ends with NAME answer
  with one call of that tool (`--force`: on the first request regardless); every other request, and the one after the tool result, answers `--reply`.
- Prints `listening <port>` on stdout once bound.

As a module: `start(record, call=None, args=None, reply="ok", port=0, keep_body=False, force=False) -> (server, port)`; `server.shutdown()`.
Requests are matched by path only; the key header is never recorded.
"""
import argparse, json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _tool_names(body):
    out = []
    for t in body.get("tools") or []:
        if isinstance(t, dict):
            out.append((t.get("function") or {}).get("name") or t.get("name") or "")
    return out


def _has_tool_result(body):
    for m in body.get("messages") or []:
        if m.get("role") == "tool":
            return True
        c = m.get("content")
        if isinstance(c, list) and any(isinstance(x, dict) and x.get("type") == "tool_result" for x in c):
            return True
    return False


class State:
    def __init__(self, record, call, args, reply, keep_body, force=False):
        self.record, self.call, self.args, self.reply, self.keep_body, self.force = record, call, args or {}, reply, keep_body, force
        self.n = 0
        self.fired = False
        self.lock = threading.Lock()


def make_handler(st):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _json(self, code, obj):
            b = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            if self.path.rstrip("/").endswith("/models"):
                self._json(200, {"object": "list", "data": [{"id": "fake-model", "object": "model"}]})
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self):
            n = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(n) if n else b""
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                body = {}
            path = self.path.split("?")[0]
            names = _tool_names(body)
            with st.lock:
                st.n += 1
                idx = st.n
                offered_match = next((x for x in names if x == st.call or x.endswith(st.call or "\0")), None)
                # --force: fire on the first request even when the tool is not in the offered list (a deferred or
                # denied tool: what does the harness do with a call the model should not be able to make?)
                fire = bool(st.call) and not st.fired and not _has_tool_result(body) and (offered_match is not None or st.force)
                if fire:
                    st.fired = True
                    tool = offered_match or st.call
            if st.record:
                rec = {"n": idx, "t": round(time.time(), 3), "path": path, "model": body.get("model"), "tools": names, "tool_choice": body.get("tool_choice"),
                       "stream": bool(body.get("stream")), "n_messages": len(body.get("messages") or []), "fired": fire}
                if st.keep_body:
                    rec["body"] = body
                with open(st.record, "a") as f:
                    f.write(json.dumps(rec) + "\n")
            stream = bool(body.get("stream"))
            if path.endswith("/messages"):
                self._anthropic(body, stream, tool if fire else None, idx)
            elif path.endswith("/chat/completions"):
                self._openai(body, stream, tool if fire else None, idx)
            else:
                self._json(404, {"error": "unknown path"})

        # -- OpenAI --------------------------------------------------------------------------
        def _openai(self, body, stream, tool, idx):
            model = body.get("model") or "fake-model"
            msg = {"role": "assistant", "content": None if tool else st.reply}
            if tool:
                msg["tool_calls"] = [{"id": f"call_{idx}", "type": "function", "function": {"name": tool, "arguments": json.dumps(st.args)}}]
            finish = "tool_calls" if tool else "stop"
            usage = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
            if not stream:
                self._json(200, {"id": f"chatcmpl-{idx}", "object": "chat.completion", "created": 0, "model": model, "choices": [{"index": 0, "message": msg, "finish_reason": finish}], "usage": usage})
                return
            chunks = [{"choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]}]
            if tool:
                chunks.append({"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": f"call_{idx}", "type": "function", "function": {"name": tool, "arguments": json.dumps(st.args)}}]}, "finish_reason": None}]})
            else:
                chunks.append({"choices": [{"index": 0, "delta": {"content": st.reply}, "finish_reason": None}]})
            chunks.append({"choices": [{"index": 0, "delta": {}, "finish_reason": finish}], "usage": usage})
            self._sse(("data: " + json.dumps({"id": f"chatcmpl-{idx}", "object": "chat.completion.chunk", "created": 0, "model": model, **c}) + "\n\n" for c in chunks), tail="data: [DONE]\n\n")

        # -- Anthropic -----------------------------------------------------------------------
        def _anthropic(self, body, stream, tool, idx):
            model = body.get("model") or "fake-model"
            content = [{"type": "tool_use", "id": f"toolu_{idx}", "name": tool, "input": st.args}] if tool else [{"type": "text", "text": st.reply}]
            stop = "tool_use" if tool else "end_turn"
            usage = {"input_tokens": 1, "output_tokens": 1}
            if not stream:
                self._json(200, {"id": f"msg_{idx}", "type": "message", "role": "assistant", "model": model, "content": content, "stop_reason": stop, "stop_sequence": None, "usage": usage})
                return
            ev = [("message_start", {"type": "message_start", "message": {"id": f"msg_{idx}", "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": usage}})]
            if tool:
                ev.append(("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": f"toolu_{idx}", "name": tool, "input": {}}}))
                ev.append(("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(st.args)}}))
            else:
                ev.append(("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}))
                ev.append(("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": st.reply}}))
            ev.append(("content_block_stop", {"type": "content_block_stop", "index": 0}))
            ev.append(("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 1}}))
            ev.append(("message_stop", {"type": "message_stop"}))
            self._sse((f"event: {k}\ndata: {json.dumps(v)}\n\n" for k, v in ev))

        def _sse(self, parts, tail=""):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "close")
            self.end_headers()
            for p in parts:
                self.wfile.write(p.encode())
                self.wfile.flush()
            if tail:
                self.wfile.write(tail.encode())
            self.wfile.flush()
            self.close_connection = True

    return H


def start(record=None, call=None, args=None, reply="ok", port=0, keep_body=False, force=False):
    st = State(record, call, args, reply, keep_body, force)
    srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(st))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--record")
    p.add_argument("--call")
    p.add_argument("--args", default="{}")
    p.add_argument("--reply", default="ok")
    p.add_argument("--keep-body", action="store_true")
    p.add_argument("--force", action="store_true", help="fire --call on the first request even if the tool is not offered")
    a = p.parse_args()
    srv, port = start(a.record, a.call, json.loads(a.args), a.reply, a.port, a.keep_body, a.force)
    print("listening", port, flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
