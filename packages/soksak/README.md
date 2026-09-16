# soksak

[한국어](README.ko.md)

A headless soksak layout library with shared grid lines, optional DOM binding, and no runtime dependencies. The library computes card geometry; applications provide content, styling, and native views.

```sh
pnpm add "github:min-median-max/soksak#path:packages/soksak"
```

The Git dependency includes `dist/`. The package uses ESM.

```js
import { Soksak, SoksakView } from "soksak";

const grid = new Soksak();
const view = new SoksakView(document.querySelector("#stage"), grid, {
  createCard: () => document.createElement("article"),
});
view.render();
```

Give `#stage` a size and `position: relative`, and set `box-sizing: border-box` on its cards.

- [Layout rules and API](docs/layout.md)

Run `pnpm test`, `pnpm breaks`, `pnpm fuzz`, and `pnpm mutate` in this directory. MIT license: [LICENSE](LICENSE).
