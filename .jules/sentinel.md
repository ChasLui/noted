## 2026-05-04 - Improve escapeHtml to prevent XSS and Theme Limits
**Vulnerability:** The `escapeHtml` function in `main.js` was missing escapes for single quotes (`'`) and backticks (`` ` ``), which could potentially allow Cross-Site Scripting (XSS) if single-quoted HTML attributes were ever introduced in the future. Also, imported theme names lacked length limits.
**Learning:** Always use a comprehensive escaping function that includes `&`, `<`, `>`, `"`, `'`, and `` ` `` to ensure robust defense against XSS, even if the current markup exclusively uses double quotes. Additionally, always bounds-check untrusted user input lengths to prevent UI layout breaking or denial of service constraints.
**Prevention:** Use an established escaping function and validate bounds for user input early.
