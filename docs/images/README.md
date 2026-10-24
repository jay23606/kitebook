# Architecture artwork

`architecture.svg` and `architecture-dark.svg` are original, editable SVG source. Both use the same geometry and differ only in palette. They are embedded with a GitHub-compatible `<picture>` so the README follows the reader's theme. All text remains text; no external fonts, scripts or remote assets are loaded.

Solid arrows mean workspace communication; dashed arrows mean optional execution and permission checks. Container outlines distinguish cloud assistants, the durable workspace and the local computer. The layout follows familiar cloud architecture diagram conventions, without using AWS service icons for a system that does not run on AWS.

Edit both variants together. Check at GitHub content width and at a narrow viewport after changing labels or geometry. Keep deployment details in `docs/architecture.md` rather than crowding the overview.
