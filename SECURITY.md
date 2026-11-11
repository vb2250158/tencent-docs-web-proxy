# Security

Report a suspected vulnerability through the repository's private vulnerability reporting feature when available. Public reports should contain a minimal synthetic reproduction.

The local WebGUI and HTTP API open directly on IPv4 loopback. The service checks Host and browser Origin and binds to `127.0.0.1`. Starting the server grants local applications access to the signed-in Tencent Docs toolbox.

Web requests use named endpoints on `https://docs.qq.com` and reject redirects. File transfers use scoped provider credentials or provider-returned HTTPS links. Tencent Docs cookies stay on the Tencent Docs origin. Third-party tools provide a native provider workflow with their own authorization requirements.

Keep cookies, official MCP tokens, COS credentials, browser profiles, recordings, transcripts, runtime journals and private document URLs in the private runtime directory. Windows session files use current-user DPAPI. Other platforms use private file permissions.

Durable request IDs and task receipts preserve unknown write outcomes. Interrupted writes require reconciliation under the original identity. Per-file results remain available when a batch has unresolved items. Editor and plugin handoffs remain in `user_action_required` while the user completes the native interaction.
