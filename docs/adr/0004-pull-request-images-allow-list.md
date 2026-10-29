# Pull request images through a backend allow-list

Images in a pull request body or comment (for example the Wiz Scan Summary card) showed only as an alt-text link, so the Pull requests view lost content that GitHub's own page shows. On 2026-10-29 (the wave 2 Pull requests grill, #915 item 6) Stuart decided to show them. The renderer's CSP stays unchanged (constitution Principle V): the backend fetches each image like it fetches avatars (`github/profile.rs`), checks the host, content type and size, and returns a `data:` URL.

Rules: only `https`; only hosts on an allow-list (GitHub's own image hosts (user-added hosts in Settings are a follow-up, so this PR ships a fixed list)); no automatic redirects, each hop re-validated against the allow-list; only `image/png`, `image/jpeg`, `image/gif` and `image/webp` (never SVG); a hard byte cap; a bounded timeout; and the fetch is reachable only from the Pull requests view, never from agent chat, where every image keeps today's alt-text link.

This relaxes Principle V for one surface: the app now makes outbound requests for URLs written by third parties. We accept that because the allow-list bounds the hosts, the response is inlined without the renderer ever contacting the host, and a hostile image can leak at most the developer's IP address to a GitHub-owned host.

**Consequences:** The follow-up Settings host list will make each new image host an explicit developer decision. Chat images are unaffected.
