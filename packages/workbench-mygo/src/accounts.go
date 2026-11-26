package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// The accounts of the plugins of a window, the core.accounts status and the core.accounts commands, as packages/workbench/accounts.js
// has them (docs/spec/plugins.md#accounts): the records of the plugin key accounts, the state that the status program of each account
// reports, the runs of the account programs through the host commands accountRun and accountRunCancel, and the homes through
// accountHomes, accountHomeCreate and accountHomeRemove.

// accountTextMax is the most characters of a name of an account and of a label of a usage line.
const accountTextMax = 40

// accountChangeReads is the reads of the stored accounts before a change gives up, as runtime.data.change does
// (docs/spec/plugins.md#plugin-data).
const accountChangeReads = 64

var (
	accountID      = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
	accountInstant = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$`)
)

// accountKind is a declared kind of the accounts of a plugin.
type accountKind struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// accountsDeclaration is the member accounts of plugin.json.
type accountsDeclaration struct {
	Kinds    []accountKind `json:"kinds"`
	Programs struct {
		Status string `json:"status"`
		Login  string `json:"login"`
		Logout string `json:"logout"`
	} `json:"programs"`
}

// accountRecord is a stored account.
type accountRecord struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// accountUsage is a usage line that a status program prints.
type accountUsage struct {
	Label  string  `json:"label"`
	Used   float64 `json:"used"`
	Resets *string `json:"resets"`
}

// accountState is what the last status run of an account printed.
type accountState struct {
	Login *bool          `json:"login"`
	Until *string        `json:"until"`
	Usage []accountUsage `json:"usage"`
}

// AccountView is an account of the core.accounts status.
type AccountView struct {
	ID      string         `json:"id"`
	Name    string         `json:"name"`
	Kind    string         `json:"kind"`
	Login   *bool          `json:"login"`
	Until   *string        `json:"until"`
	Usage   []accountUsage `json:"usage"`
	Running bool           `json:"running"`
}

// AccountsStatus is the value of core.accounts while a page of a plugin with accounts shows.
type AccountsStatus struct {
	Plugin   string        `json:"plugin"`
	Accounts []AccountView `json:"accounts"`
}

// accountError is the failure of an account command of a plugin, whose press shows it with the place settings <plugin>.
type accountError struct {
	plugin string
	err    error
}

func (e *accountError) Error() string { return e.err.Error() }
func (e *accountError) Unwrap() error { return e.err }

// programReply is the reply of a run that exited.
type programReply struct {
	Code      *int   `json:"code"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	Truncated struct {
		Stdout bool `json:"stdout"`
		Stderr bool `json:"stderr"`
	} `json:"truncated"`
}

// Accounts are the accounts of one window over its host calls.
type Accounts struct {
	shell *Shell
	// states holds what the last status run of each account printed, logins the run of each login while it runs, queues the status
	// and logout runs of each plugin that wait, and folders the folder accounts/ of each plugin that accountHomes answered.
	states  map[string]map[string]accountState
	logins  map[string]map[string]int
	queues  map[string]*accountQueue
	folders map[string]string
	lastRun int
	shown   string
}

// accountQueue runs the status and logout runs of a plugin one after another.
type accountQueue struct {
	busy    bool
	waiting []func(done func())
}

// NewAccounts returns the accounts of a window.
func NewAccounts(shell *Shell) *Accounts {
	return &Accounts{shell: shell, states: map[string]map[string]accountState{}, logins: map[string]map[string]int{},
		queues: map[string]*accountQueue{}, folders: map[string]string{}}
}

func accountName(name string) error {
	count := utf8.RuneCountInString(name)
	if count < 1 || count > accountTextMax || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return errors.New("account name must be 1 to 40 characters without a control character")
	}
	return nil
}

func accountText(text string) bool {
	count := utf8.RuneCountInString(text)
	return count >= 1 && count <= accountTextMax
}

// isInstant tells whether text is an ISO 8601 date and time.
func isInstant(text string) bool {
	if !accountInstant.MatchString(text) {
		return false
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04Z07:00"} {
		if _, err := time.Parse(layout, text); err == nil {
			return true
		}
	}
	return false
}

// members tells whether value is an object of exactly the names.
func members(value any, names ...string) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	if !ok || len(object) != len(names) {
		return nil, false
	}
	for _, name := range names {
		if _, held := object[name]; !held {
			return nil, false
		}
	}
	return object, true
}

// declared returns the accounts declaration of plugin; a plugin without accounts is refused.
func (a *Accounts) declared(plugin string) (*installedUnit, error) {
	unit := a.shell.units[plugin]
	if unit == nil || unit.Accounts == nil {
		return nil, fmt.Errorf("plugin %s declares no accounts", plugin)
	}
	return unit, nil
}

// Declares tells whether plugin declares accounts.
func (a *Accounts) Declares(plugin string) bool {
	_, err := a.declared(plugin)
	return err == nil
}

// recordsReason is why the stored records are not the current form, or "".
func recordsReason(value any, kinds []accountKind) string {
	list, ok := value.([]any)
	if !ok {
		return "must be an array of {id, name, kind}"
	}
	ids, names := map[string]bool{}, map[string]bool{}
	for index, item := range list {
		record, ok := members(item, "id", "name", "kind")
		if !ok {
			return fmt.Sprintf("record %d must be {id, name, kind}", index)
		}
		id, isID := record["id"].(string)
		if !isID || !accountID.MatchString(id) {
			encoded, err := json.Marshal(record["id"])
			if err != nil {
				return fmt.Sprintf("record %d id is not an account identifier", index)
			}
			return fmt.Sprintf("record %d id %s is not an account identifier", index, encoded)
		}
		name, isName := record["name"].(string)
		if !isName || accountName(name) != nil {
			return fmt.Sprintf("record %d name must be 1 to 40 characters without a control character", index)
		}
		kind, isKind := record["kind"].(string)
		if !isKind || !slices.ContainsFunc(kinds, func(declared accountKind) bool { return declared.Value == kind }) {
			encoded, err := json.Marshal(record["kind"])
			if err != nil {
				return fmt.Sprintf("record %d kind is not declared", index)
			}
			return fmt.Sprintf("record %d kind %s is not declared", index, encoded)
		}
		if ids[id] {
			return fmt.Sprintf("id %s repeats", id)
		}
		if names[name] {
			return fmt.Sprintf("name %s repeats", name)
		}
		ids[id], names[name] = true, true
	}
	return ""
}

// Records returns the stored records of plugin; a record of another form fails with the plugin and the reason.
func (a *Accounts) Records(plugin string) ([]accountRecord, error) {
	unit, err := a.declared(plugin)
	if err != nil {
		return nil, err
	}
	raw, err := a.shell.readPluginKey(unit, "accounts")
	if err != nil {
		return nil, err
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("plugin %s data accounts: %w", plugin, err)
	}
	if reason := recordsReason(value, unit.Accounts.Kinds); reason != "" {
		return nil, fmt.Errorf("plugin %s data accounts: %s", plugin, reason)
	}
	var records []accountRecord
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, fmt.Errorf("plugin %s data accounts: %w", plugin, err)
	}
	return records, nil
}

func (a *Accounts) record(plugin, id string) (accountRecord, error) {
	records, err := a.Records(plugin)
	if err != nil {
		return accountRecord{}, err
	}
	for _, record := range records {
		if record.ID == id {
			return record, nil
		}
	}
	return accountRecord{}, fmt.Errorf("account %s is not defined", id)
}

func (a *Accounts) refuseRunning(plugin string, record accountRecord) error {
	if _, running := a.logins[plugin][record.ID]; running {
		return fmt.Errorf("the login of account %s is running", record.Name)
	}
	return nil
}

// change stores the records that next makes from the stored records, with the stored records as the base, and reads them again when
// another window stored first. next answers its refusal against the records that stand.
func (a *Accounts) change(plugin string, next func([]accountRecord) ([]accountRecord, error), done func(error)) {
	var attempt func(reads int)
	attempt = func(reads int) {
		if reads == accountChangeReads {
			done(fmt.Errorf("accounts of %s: other writers changed the records %d times", plugin, accountChangeReads))
			return
		}
		unit, err := a.declared(plugin)
		if err != nil {
			done(err)
			return
		}
		records, err := a.Records(plugin)
		if err != nil {
			done(err)
			return
		}
		base, err := json.Marshal(records)
		if err != nil {
			done(err)
			return
		}
		changed, err := next(slices.Clone(records))
		if err != nil {
			done(err)
			return
		}
		value, err := json.Marshal(changed)
		if err != nil {
			done(err)
			return
		}
		err = a.shell.writePluginKey(unit, "accounts", value, base, func(stored bool, err error) {
			if err != nil {
				done(err)
				return
			}
			if !stored {
				attempt(reads + 1)
				return
			}
			a.shell.options.Invalidate()
			done(nil)
		})
		if err != nil {
			done(err)
		}
	}
	attempt(0)
}

// homes answers the folder accounts/ of plugin and the names of its folders through accountHomes.
func (a *Accounts) homes(plugin string, answer func(folder string, names []string, err error)) {
	a.shell.calls.Call("accountHomes", map[string]any{"plugin": plugin}, func(value any, err error) {
		if err != nil {
			answer("", nil, err)
			return
		}
		homes, err := decode[struct {
			Folder string   `json:"folder"`
			Names  []string `json:"names"`
		}](value)
		if err != nil {
			answer("", nil, err)
			return
		}
		a.folders[plugin] = homes.Folder
		answer(homes.Folder, homes.Names, nil)
	})
}

// exitReason is why a run did not exit 0 with a whole output, or "".
func exitReason(reply programReply) string {
	if reply.Code != nil && *reply.Code == 0 && !reply.Truncated.Stdout {
		return ""
	}
	// The last line of the error output names the failure; a program that wrote nothing there adds no text to the reason.
	lines := strings.Split(strings.TrimSpace(reply.Stderr), "\n")
	tail := ""
	if last := lines[len(lines)-1]; last != "" {
		tail = ": " + last
	}
	switch {
	case reply.Code == nil:
		return "ended without an exit status" + tail
	case *reply.Code != 0:
		return fmt.Sprintf("exited with %d%s", *reply.Code, tail)
	}
	return "printed a truncated output"
}

// run runs the account program of the role for record and answers its reply, or nil for a run that ended before its exit. started
// receives the number of the run before it is sent.
func (a *Accounts) run(plugin, role string, record accountRecord, started func(run int), answer func(*programReply, error)) {
	unit, err := a.declared(plugin)
	if err != nil {
		answer(nil, err)
		return
	}
	programs := map[string]string{"status": unit.Accounts.Programs.Status, "login": unit.Accounts.Programs.Login, "logout": unit.Accounts.Programs.Logout}
	name := programs[role]
	send := func(folder string) {
		a.lastRun++
		run := a.lastRun
		started(run)
		request := map[string]any{"plugin": plugin, "programs": unit.Programs, "run": run, "name": name, "args": []string{record.Kind, folder + "/" + record.ID}}
		a.shell.calls.Call("accountRun", request, func(value any, err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			if value == nil {
				answer(nil, nil)
				return
			}
			reply, err := decode[programReply](value)
			if err != nil {
				answer(nil, err)
				return
			}
			if reason := exitReason(reply); reason != "" {
				answer(nil, fmt.Errorf("account %s: %s %s", record.Name, name, reason))
				return
			}
			answer(&reply, nil)
		})
	}
	if folder, ok := a.folders[plugin]; ok {
		send(folder)
		return
	}
	a.homes(plugin, func(folder string, _ []string, err error) {
		if err != nil {
			answer(nil, err)
			return
		}
		send(folder)
	})
}

// queue runs fn after the queued runs of plugin, so the status and logout runs of a plugin follow one another.
func (a *Accounts) queue(plugin string, fn func(done func())) {
	queue := a.queues[plugin]
	if queue == nil {
		queue = &accountQueue{}
		a.queues[plugin] = queue
	}
	queue.waiting = append(queue.waiting, fn)
	a.next(queue)
}

func (a *Accounts) next(queue *accountQueue) {
	if queue.busy || len(queue.waiting) == 0 {
		return
	}
	fn := queue.waiting[0]
	queue.waiting = queue.waiting[1:]
	queue.busy = true
	fn(func() {
		queue.busy = false
		a.next(queue)
	})
}

// statusReason is why the output of a status program is not {login, until, usage}, or "".
func statusReason(stdout string) (accountState, string) {
	var value any
	if err := json.Unmarshal([]byte(stdout), &value); err != nil {
		return accountState{}, "printed no JSON"
	}
	object, ok := members(value, "login", "until", "usage")
	if !ok {
		return accountState{}, "printed no object {login, until, usage}"
	}
	if _, isBool := object["login"].(bool); !isBool && object["login"] != nil {
		return accountState{}, "printed a login that is not true, false or null"
	}
	if until, isText := object["until"].(string); object["until"] != nil && (!isText || !isInstant(until)) {
		return accountState{}, "printed an until that is not an ISO 8601 text or null"
	}
	usage, isList := object["usage"].([]any)
	if !isList {
		return accountState{}, "printed a usage that is not a list"
	}
	for index, item := range usage {
		line, ok := members(item, "label", "used", "resets")
		if !ok {
			return accountState{}, fmt.Sprintf("printed usage %d that is not {label, used, resets}", index)
		}
		if label, isText := line["label"].(string); !isText || !accountText(label) {
			return accountState{}, fmt.Sprintf("printed usage %d with a label that is not 1 to 40 characters", index)
		}
		if used, isNumber := line["used"].(float64); !isNumber || used < 0 || used > 100 {
			return accountState{}, fmt.Sprintf("printed usage %d with a used that is not a number from 0 to 100", index)
		}
		if resets, isText := line["resets"].(string); line["resets"] != nil && (!isText || !isInstant(resets)) {
			return accountState{}, fmt.Sprintf("printed usage %d with a resets that is not an ISO 8601 text or null", index)
		}
	}
	var state accountState
	if err := json.Unmarshal([]byte(stdout), &state); err != nil {
		return accountState{}, "printed no JSON"
	}
	return state, ""
}

// readState runs status for the account id of plugin and keeps what it printed; a failure is shown and keeps the state before.
func (a *Accounts) readState(plugin, id string) {
	a.queue(plugin, func(done func()) {
		record, err := a.record(plugin, id)
		if err != nil {
			done()
			return
		}
		a.run(plugin, "status", record, func(int) {}, func(reply *programReply, err error) {
			defer done()
			if err != nil {
				a.fail(plugin, err)
				return
			}
			if reply == nil {
				return
			}
			unit, err := a.declared(plugin)
			if err != nil {
				a.fail(plugin, err)
				return
			}
			state, reason := statusReason(reply.Stdout)
			if reason != "" {
				a.fail(plugin, fmt.Errorf("account %s: %s %s", record.Name, unit.Accounts.Programs.Status, reason))
				return
			}
			if a.states[plugin] == nil {
				a.states[plugin] = map[string]accountState{}
			}
			a.states[plugin][id] = state
			a.shell.options.Invalidate()
		})
	})
}

// readStates runs status for every account of plugin; a failure of the records is shown.
func (a *Accounts) readStates(plugin string) {
	records, err := a.Records(plugin)
	if err != nil {
		a.fail(plugin, err)
		return
	}
	for _, record := range records {
		a.readState(plugin, record.ID)
	}
}

// fail shows err through the error display with the place settings <plugin>.
func (a *Accounts) fail(plugin string, err error) {
	a.shell.errors.Show("settings "+plugin, err.Error(), "")
	a.shell.options.Invalidate()
}

// freeAccountID is the least account-<n> that no record and no home has.
func freeAccountID(records []accountRecord, names []string) string {
	used := map[string]bool{}
	for _, record := range records {
		used[record.ID] = true
	}
	for _, name := range names {
		used[name] = true
	}
	for n := 1; ; n++ {
		if id := fmt.Sprintf("account-%d", n); !used[id] {
			return id
		}
	}
}

// Add creates the home of a new account and stores it, and answers its identifier.
func (a *Accounts) Add(plugin, name, kind string, answer func(id string, err error)) {
	unit, err := a.declared(plugin)
	if err == nil {
		err = accountName(name)
	}
	if err == nil && !slices.ContainsFunc(unit.Accounts.Kinds, func(declared accountKind) bool { return declared.Value == kind }) {
		err = fmt.Errorf("account kind %s is not declared by %s", kind, plugin)
	}
	var records []accountRecord
	if err == nil {
		records, err = a.Records(plugin)
	}
	if err == nil && slices.ContainsFunc(records, func(record accountRecord) bool { return record.Name == name }) {
		err = fmt.Errorf("account name %s is already used", name)
	}
	if err != nil {
		answer("", err)
		return
	}
	a.homes(plugin, func(_ string, names []string, err error) {
		if err != nil {
			answer("", err)
			return
		}
		id := freeAccountID(records, names)
		a.shell.calls.Call("accountHomeCreate", map[string]any{"plugin": plugin, "id": id}, func(_ any, err error) {
			if err != nil {
				answer("", err)
				return
			}
			a.change(plugin, func(stored []accountRecord) ([]accountRecord, error) {
				if slices.ContainsFunc(stored, func(record accountRecord) bool { return record.Name == name }) {
					return nil, fmt.Errorf("account name %s is already used", name)
				}
				if slices.ContainsFunc(stored, func(record accountRecord) bool { return record.ID == id }) {
					return nil, fmt.Errorf("account %s is already defined", id)
				}
				return append(stored, accountRecord{ID: id, Name: name, Kind: kind}), nil
			}, func(err error) {
				if err == nil {
					a.shell.accountFinished("core.accounts.add", plugin)
					a.readState(plugin, id)
					answer(id, nil)
					return
				}
				// The home of an identifier that no record holds belongs to no account; a home that a record of another window holds stays.
				if _, held := a.record(plugin, id); held == nil {
					answer("", err)
					return
				}
				a.shell.calls.Call("accountHomeRemove", map[string]any{"plugin": plugin, "id": id}, func(_ any, removed error) {
					answer("", errors.Join(err, removed))
				})
			})
		})
	})
}

// Rename changes the name of an account and keeps its identifier and home.
func (a *Accounts) Rename(plugin, id, name string, answer func(error)) {
	err := accountName(name)
	var record accountRecord
	if err == nil {
		record, err = a.record(plugin, id)
	}
	if err == nil {
		err = a.refuseRunning(plugin, record)
	}
	if err != nil {
		answer(err)
		return
	}
	a.change(plugin, func(stored []accountRecord) ([]accountRecord, error) {
		index := slices.IndexFunc(stored, func(item accountRecord) bool { return item.ID == id })
		if index < 0 {
			return nil, fmt.Errorf("account %s is not defined", id)
		}
		if slices.ContainsFunc(stored, func(item accountRecord) bool { return item.ID != id && item.Name == name }) {
			return nil, fmt.Errorf("account name %s is already used", name)
		}
		stored[index].Name = name
		return stored, nil
	}, func(err error) {
		if err == nil {
			a.shell.accountFinished("core.accounts.rename", plugin)
			a.readState(plugin, id)
		}
		answer(err)
	})
}

// Remove removes an account and its home.
func (a *Accounts) Remove(plugin, id string, answer func(error)) {
	record, err := a.record(plugin, id)
	if err == nil {
		err = a.refuseRunning(plugin, record)
	}
	if err != nil {
		answer(err)
		return
	}
	a.change(plugin, func(stored []accountRecord) ([]accountRecord, error) {
		if !slices.ContainsFunc(stored, func(item accountRecord) bool { return item.ID == id }) {
			return nil, fmt.Errorf("account %s is not defined", id)
		}
		return slices.DeleteFunc(stored, func(item accountRecord) bool { return item.ID == id }), nil
	}, func(err error) {
		if err != nil {
			answer(err)
			return
		}
		delete(a.states[plugin], id)
		a.shell.calls.Call("accountHomeRemove", map[string]any{"plugin": plugin, "id": id}, func(_ any, err error) {
			a.shell.options.Invalidate()
			answer(err)
		})
	})
}

// Login runs the login program of an account and answers when it ends; a cancelled login answers without an error.
func (a *Accounts) Login(plugin, id string, answer func(error)) {
	record, err := a.record(plugin, id)
	if err == nil {
		err = a.refuseRunning(plugin, record)
	}
	if err != nil {
		answer(err)
		return
	}
	if a.logins[plugin] == nil {
		a.logins[plugin] = map[string]int{}
	}
	a.run(plugin, "login", record, func(run int) {
		a.logins[plugin][id] = run
		a.shell.options.Invalidate()
	}, func(reply *programReply, err error) {
		delete(a.logins[plugin], id)
		a.shell.options.Invalidate()
		if err == nil && reply != nil {
			a.readState(plugin, id)
		}
		answer(err)
	})
}

// LoginCancel ends the login that runs for an account.
func (a *Accounts) LoginCancel(plugin, id string, answer func(error)) {
	record, err := a.record(plugin, id)
	if err != nil {
		answer(err)
		return
	}
	run, running := a.logins[plugin][id]
	if !running {
		answer(fmt.Errorf("no login of account %s is running", record.Name))
		return
	}
	a.shell.calls.Call("accountRunCancel", map[string]any{"plugin": plugin, "run": run}, func(_ any, err error) { answer(err) })
}

// Logout runs the logout program of an account after the queued runs of its plugin.
func (a *Accounts) Logout(plugin, id string, answer func(error)) {
	record, err := a.record(plugin, id)
	if err == nil {
		err = a.refuseRunning(plugin, record)
	}
	if err != nil {
		answer(err)
		return
	}
	a.queue(plugin, func(done func()) {
		a.run(plugin, "logout", record, func(int) {}, func(_ *programReply, err error) {
			done()
			if err == nil {
				a.readState(plugin, id)
			}
			answer(err)
		})
	})
}

// compareNames orders two names by their code points, as packages/workbench/accounts.js does.
func compareNames(one, other string) int {
	a, b := []rune(one), []rune(other)
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return int(a[i]) - int(b[i])
		}
	}
	return len(a) - len(b)
}

// List returns the accounts of plugin in the order of their names, with the state of their last status run and whether their login
// runs.
func (a *Accounts) List(plugin string) ([]AccountView, error) {
	records, err := a.Records(plugin)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(records, func(i, j int) bool { return compareNames(records[i].Name, records[j].Name) < 0 })
	views := make([]AccountView, len(records))
	for i, record := range records {
		state, ok := a.states[plugin][record.ID]
		if !ok {
			state = accountState{Usage: []accountUsage{}}
		}
		_, running := a.logins[plugin][record.ID]
		views[i] = AccountView{ID: record.ID, Name: record.Name, Kind: record.Kind, Login: state.Login, Until: state.Until, Usage: state.Usage, Running: running}
	}
	return views, nil
}

// Show records the plugin whose page the settings window shows, or ""; a page of a plugin with accounts that appears reads them.
func (a *Accounts) Show(plugin string) {
	appears := plugin != a.shown
	a.shown = plugin
	if appears && plugin != "" && a.Declares(plugin) {
		a.readStates(plugin)
	}
}

// Event reads the accounts of the shown page again when the window becomes the key window.
func (a *Accounts) Event() {
	if a.shown != "" && a.Declares(a.shown) {
		a.readStates(a.shown)
	}
}

// Status returns the value of core.accounts, nil while no page of a plugin with accounts shows. A record of another form is shown
// through the error display, and the status holds no account.
func (a *Accounts) Status() any {
	if a.shown == "" || !a.Declares(a.shown) {
		return nil
	}
	views, err := a.List(a.shown)
	if err != nil {
		a.fail(a.shown, err)
		views = []AccountView{}
	}
	return AccountsStatus{Plugin: a.shown, Accounts: views}
}

// accountParams are the parameters of the account commands.
type accountParams struct {
	Plugin string `json:"plugin"`
	ID     string `json:"id"`
	Name   string `json:"name"`
	Kind   string `json:"kind"`
}

// registerAccounts adds the status and the commands of the accounts.
func (s *Shell) registerAccounts() {
	s.registry.Status("core.accounts", s.accounts.Status)
	wrap := func(plugin string, err error) error {
		if err == nil {
			return nil
		}
		return &accountError{plugin: plugin, err: err}
	}
	later(s, "core.accounts.add", func(value accountParams, answer func(any, error)) {
		s.accounts.Add(value.Plugin, value.Name, value.Kind, func(id string, err error) {
			if err != nil {
				answer(nil, wrap(value.Plugin, err))
				return
			}
			answer(map[string]string{"id": id}, nil)
		})
	})
	done := func(plugin string, answer func(any, error)) func(error) {
		return func(err error) { answer(nil, wrap(plugin, err)) }
	}
	later(s, "core.accounts.rename", func(value accountParams, answer func(any, error)) {
		s.accounts.Rename(value.Plugin, value.ID, value.Name, done(value.Plugin, answer))
	})
	later(s, "core.accounts.remove", func(value accountParams, answer func(any, error)) {
		s.accounts.Remove(value.Plugin, value.ID, done(value.Plugin, answer))
	})
	later(s, "core.accounts.login", func(value accountParams, answer func(any, error)) {
		s.accounts.Login(value.Plugin, value.ID, done(value.Plugin, answer))
	})
	later(s, "core.accounts.login-cancel", func(value accountParams, answer func(any, error)) {
		s.accounts.LoginCancel(value.Plugin, value.ID, done(value.Plugin, answer))
	})
	later(s, "core.accounts.logout", func(value accountParams, answer func(any, error)) {
		s.accounts.Logout(value.Plugin, value.ID, done(value.Plugin, answer))
	})
}

// pressFailed shows the failure of the command of a pressed element: the failure of an account command with the place settings
// <plugin> (docs/spec/plugins.md#accounts), and any other failure with the place of the workbench.
func (s *Shell) pressFailed(err error) {
	var account *accountError
	if errors.As(err, &account) {
		s.accounts.fail(account.plugin, account.err)
		return
	}
	s.fail(err)
}
