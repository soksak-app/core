# Using `sok`

[한국어](sok.ko.md)

`sok` drives a soksak application from a terminal: it lists windows, reads statuses, runs any command that core or a plugin declares, and sends native input. The contract is [command line `sok`](../spec/cli.md).

## Reach `sok` from a shell

Each application bundle holds its own `sok` next to its executable. Put it on `PATH` once, from the bundle of the application you use:

```sh
sudo /Applications/<application>.app/Contents/MacOS/sok path install
```

A new shell then finds `sok`, and that `sok` talks to that application and uses its configuration directory. `sudo sok path remove` takes it off `PATH` again. To drive an application started with `--config-dir`, give `sok` the same `--config-dir`.

## Drive a window

```sh
sok windows                                   # windows of the running application
sok commands --project ~/work                 # commands that core and the plugins declare
sok core.card.split --project ~/work --card shell --side right --plugin terminal
sok terminal.input --project ~/work --surface <tab> --bytes 'npm test\r'
sok status core.screen --watch                # the value, then one line per change
```

`--window <name>` or `--project <directory>` selects the window; without either, `sok` uses the only window and asks for a selection when there are several. A declared command takes its parameters as flags from its declared schema (`sok commands` shows them) or as one JSON object with `--params`. A value that starts with `--` is written after `=`, as in `--text=--x`.

Every result is JSON on standard output, so the result of one call can feed the next, for example the `tab` that `core.card.split` prints. Errors go to standard error. The exit status is 0 on success, 1 when the command fails, and 2 when the call is written wrong, which also prints the usage.
