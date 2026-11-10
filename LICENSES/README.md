# Third-party notices

The build setup and bundled Windy declarations derive from
[windy-plugin-template](https://github.com/windycom/windy-plugin-template). Its package metadata names
Windyty, S.E. as author and declares ISC. [windy-plugin-template.txt](windy-plugin-template.txt) preserves
that attribution and the ISC permission and disclaimer text; no copyright year is inferred.

The generated JavaScript includes the [Svelte](https://github.com/sveltejs/svelte) runtime, under MIT.
Every production build copies the installed package's complete `node_modules/svelte/LICENSE.md` to
`dist/LICENSES/svelte.txt`, preserving the notice that accompanies that dependency version.

The build also copies this directory and the project's own MIT `LICENSE` into `dist/`. The publishing
script packages those notices with the JavaScript and refuses a build missing a required notice.
