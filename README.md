# soksak

[한국어](README.ko.md)

A headless soksak layout library with shared grid lines, optional DOM binding, and no runtime dependencies. The library computes card geometry; applications provide content, styling, and native views.

```sh
pnpm add github:min-median-max/soksak
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

- [Layout rules and API](docs/spec/layout.md)
- [Example applications](examples/README.md)
- [Native surface placement](docs/spec/native-surfaces.md)
- [data-native-modal](docs/spec/native-modals.md)
- [Private native APIs and update review](docs/operations/private-native-apis.md)
- [Implementation, validation, and release status](docs/features.md)
- [Changes](CHANGELOG.md)
- [Development and required checks](AGENTS.md)

MIT license: [LICENSE](LICENSE).
