# Security

Report a suspected vulnerability through the repository's private vulnerability reporting feature when available. Public issues should contain only a minimal synthetic reproduction.

Do not publish real Cookie headers, API tokens, COS temporary credentials, browser profiles, HAR files, audio/video recordings, transcripts or private document URLs. Runtime data belongs outside this repository. If a credential was exposed, invalidate the relevant session and replace the local API token.

The HTTP API binds only to IPv4 loopback, requires a local Bearer token and rejects browser Origin headers and unexpected Host headers. Upstream web requests are restricted to the known Tencent Docs paths and do not follow redirects. COS uploads use temporary provider credentials. There is no generic URL forwarding, credential extraction from existing browser databases, account sharing service or remote-listener mode.

Windows session files are protected with the current user's DPAPI. Other platforms use file permissions; Chrome's dedicated login profile contains sensitive browser data on every platform. Keep the entire runtime directory private.
