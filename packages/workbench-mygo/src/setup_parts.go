package workbench

import (
	"encoding/json"
	"fmt"
	"slices"
)

// The setup parts of the agents of the machine, the agent group of the settings tab, the `core.setup` status and the
// setup commands, as packages/workbench/setup-parts.js has them (docs/spec/settings.md#agents).
// The parts are read when the group is shown, and while it is shown when the window becomes the key window and after
// setup-changed, and by core.setup.check; no timer reads them, because the configuration file of the agent is rewritten by every
// agent session.

// setupKinds are the kinds of parts that the application installs on request.
var setupKinds = []string{"skill", "mcp"}

// SetupPart is a setup part as the host call setupState answers it.
type SetupPart struct {
	Part    string `json:"part"`
	File    string `json:"file"`
	State   string `json:"state"`
	Step    string `json:"step"`
	Reason  string `json:"reason,omitempty"`
	Error   string `json:"error,omitempty"`
	Changed *bool  `json:"changed,omitempty"`
	Enabled *bool  `json:"enabled,omitempty"`
}

// SetupParts is the answer of a setup call.
type SetupParts struct {
	Parts []SetupPart `json:"parts"`
}

// SetupStatus is the value of `core.setup`. Running is nil while no setup operation runs.
type SetupStatus struct {
	Parts   []SetupPart `json:"parts"`
	Running []string    `json:"running"`
}

// SetupOperations are the setup parts of one window over its host calls. changed is called when the parts or the current
// operation change, and fail shows a failed read or operation through the error display, which writes it to the application log. A
// failure keeps the parts of the last read.
type SetupOperations struct {
	calls   *Calls
	changed func()
	fail    func(error)
	parts   []SetupPart
	running []string
	shown   bool
	// lastRead is the number of the last started read or operation: a read that ends after a later one started does not replace its
	// parts.
	lastRead int
	// generation advances with each change that touch reports, so a reader of the parts rebuilds its view once per change.
	generation uint64
}

// touch records a change of the parts or the operation and tells the window.
func (p *SetupOperations) touch() {
	p.generation++
	p.changed()
}

// Generation returns the number of changes of the parts and the operation.
func (p *SetupOperations) Generation() uint64 { return p.generation }

// NewSetupOperations returns the setup parts of a window over its host calls.
func NewSetupOperations(calls *Calls, changed func(), fail func(error)) *SetupOperations {
	return &SetupOperations{calls: calls, changed: changed, fail: fail, parts: []SetupPart{}}
}

// Status returns the value of `core.setup`.
func (p *SetupOperations) Status() SetupStatus {
	return SetupStatus{Parts: p.parts, Running: p.running}
}

// Parts returns the parts of the last read or install.
func (p *SetupOperations) Parts() []SetupPart { return p.parts }

// Read reads the parts through setupState and answers them; a failure is shown and answered.
func (p *SetupOperations) Read(answer func(*SetupParts, error)) {
	p.lastRead++
	order := p.lastRead
	p.calls.Call("setupState", nil, func(value any, err error) {
		var parts SetupParts
		if err == nil {
			parts, err = decodeSetupParts(value)
		}
		if err != nil {
			p.fail(fmt.Errorf("setup: %w", err))
			answer(nil, err)
			return
		}
		if order == p.lastRead {
			p.parts = parts.Parts
			p.touch()
		}
		answer(&parts, nil)
	})
}

// Install installs the kinds through setupInstall.
func (p *SetupOperations) Install(kinds []string, answer func(*SetupParts, error)) {
	p.apply("setupInstall", map[string]any{"parts": kinds}, kinds, answer)
}

type setupChange struct {
	Part    string `json:"part"`
	Enabled bool   `json:"enabled"`
}

// Change saves and applies the desired state of a setup part through setupChange.
func (p *SetupOperations) Change(change setupChange, answer func(*SetupParts, error)) {
	p.apply("setupChange", change, []string{change.Part}, answer)
}

// apply publishes the parts of one operation at a time and reports a refused or failed operation.
func (p *SetupOperations) apply(method string, params any, kinds []string, answer func(*SetupParts, error)) {
	if p.running != nil {
		err := fmt.Errorf("another setup operation is running")
		p.fail(fmt.Errorf("setup: %w", err))
		answer(nil, err)
		return
	}
	p.running = kinds
	p.touch()
	p.lastRead++
	order := p.lastRead
	p.calls.Call(method, params, func(value any, err error) {
		p.running = nil
		var parts SetupParts
		if err == nil {
			parts, err = decodeSetupParts(value)
		}
		if err != nil {
			p.touch()
			p.fail(fmt.Errorf("setup: %w", err))
			answer(nil, err)
			return
		}
		if order == p.lastRead {
			p.parts = parts.Parts
		}
		p.touch()
		answer(&parts, nil)
	})
}

// Show records whether the agent group is shown; showing it reads the parts.
func (p *SetupOperations) Show(shown bool) {
	appears := shown && !p.shown
	p.shown = shown
	if appears {
		p.reread()
	}
}

// Event reads the parts again on window-active and setup-changed while the group is shown.
func (p *SetupOperations) Event() {
	if p.shown {
		p.reread()
	}
}

// reread is a read that an event or the showing of the group starts; Read already showed its failure.
func (p *SetupOperations) reread() {
	p.Read(func(*SetupParts, error) {})
}

// decodeSetupParts reads the answer of a setup call. An answer without a list is an error of the host.
func decodeSetupParts(value any) (SetupParts, error) {
	parts, err := decode[SetupParts](value)
	if err != nil {
		return parts, err
	}
	if parts.Parts == nil {
		return parts, fmt.Errorf("the host answered no setup parts")
	}
	return parts, nil
}

// missingSetupKinds are the kinds of setupKinds that have a part that is not ok, in the order of setupKinds.
func missingSetupKinds(parts []SetupPart) []string {
	kinds := []string{}
	for _, kind := range setupKinds {
		if slices.ContainsFunc(parts, func(part SetupPart) bool { return part.Part == kind && part.State != "ok" }) {
			kinds = append(kinds, kind)
		}
	}
	return kinds
}

// setupInstallKinds returns the kinds of the parameter parts when it is a non-empty list of setupKinds without repetition, and
// the invalid-params refusal otherwise.
func setupInstallKinds(value any) ([]string, error) {
	list, ok := value.([]any)
	kinds := make([]string, 0, len(list))
	for _, item := range list {
		kind, isText := item.(string)
		if !isText || !slices.Contains(setupKinds, kind) || slices.Contains(kinds, kind) {
			ok = false
			break
		}
		kinds = append(kinds, kind)
	}
	if !ok || len(kinds) == 0 {
		text, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		return nil, Refuse(InvalidParams, "parts must be a non-empty list of skill and mcp without repetition: %s", text)
	}
	return kinds, nil
}

// registerSetup adds the status and the commands of the setup parts.
func (s *Shell) registerSetup() {
	s.registry.Status("core.setup", func() any { return s.setupOperations.Status() })
	later(s, "core.setup.check", func(_ struct{}, answer func(any, error)) {
		s.setupOperations.Read(func(parts *SetupParts, err error) { answer(parts, err) })
	})
	later(s, "core.setup.install", func(value struct {
		Parts any `json:"parts"`
	}, answer func(any, error)) {
		kinds, err := setupInstallKinds(value.Parts)
		if err != nil {
			answer(nil, err)
			return
		}
		s.setupOperations.Install(kinds, func(parts *SetupParts, err error) { answer(parts, err) })
	})
	later(s, "core.setup.change", func(change setupChange, answer func(any, error)) {
		s.setupOperations.Change(change, func(parts *SetupParts, err error) { answer(parts, err) })
	})
}

// setupNames are the names of the setup parts, and setupStates the texts of their states.
var (
	setupNames  = map[string]string{"path": "명령 경로", "skill": "스킬", "mcp": "MCP 등록", "hook": "훅"}
	setupStates = map[string]string{"ok": "설치됨", "absent": "없음", "differs": "다름"}
)

// buildSetup adds the agent group. A path row has a control for its desired state. The group also has the install button while a
// skill or mcp part is not ok and the check button. A part's error goes through the error display path.
func (s *Shell) buildSetup(b *settingsBuilder) {
	parts := s.setupOperations.Parts()
	rows := make([]settingsRow, 0, len(parts)+2)
	for _, part := range parts {
		key := "setup:" + part.Part + ":" + part.File
		state := setupStates[part.State]
		if part.State == "missing" {
			state = setupStates[part.Reason]
		}
		if part.Enabled != nil && !*part.Enabled {
			state = "사용 안 함"
		}
		if part.State == "error" {
			state = part.Error
			s.errors.Show(key, part.Error, "")
		}
		// The label is the text of the row in document order, as the page reports the textContent of its row.
		control := b.add(SettingsControl{Name: "core.settings-tab.setup", Key: text(key), Label: setupNames[part.Part] + state + part.File,
			kind: controlSetup, setup: &setupRow{name: setupNames[part.Part], state: state, file: part.File, failed: part.State == "error"}})
		if part.Part == "path" && part.Enabled != nil {
			label := "켜기"
			if *part.Enabled {
				label = "끄기"
			}
			control.Label += label
			control.setup.action = b.button("setup-change:path", "core.settings-tab.setup-change", label, "core.setup.change",
				map[string]any{"part": "path", "enabled": !*part.Enabled})
		}
		// A missing skill or mcp part has its own button: Repair when the file differs, else the button core.settings-tab.setup-install (docs/spec/settings.md#agents).
		if (part.Part == "skill" || part.Part == "mcp") && part.State == "missing" {
			label := "설치"
			if part.Reason == "differs" {
				label = "고치기"
			}
			control.setup.action = b.small(key, "core.settings-tab.setup-install", label, "core.setup.install", map[string]any{"parts": []string{part.Part}})
		}
		rows = append(rows, settingsRow{controls: []*SettingsControl{control}, list: true})
	}
	if len(parts) == 0 {
		rows = append(rows, settingsRow{description: "이 컴퓨터에서 설정할 에이전트 항목이 없습니다."})
	}
	// The install-all control (element `setup-install-all`, command `core.settings-tab.setup-install-all`) is always shown and is disabled when no part of the skill and mcp kinds is not ok (docs/spec/settings.md#agents).
	// The summary is the badge of the count of the parts that differ or are missing with the warning icon, or All installed when every part is
	// ok (docs/spec/settings.md#agents).
	summary := b.add(SettingsControl{Name: "core.settings-tab.badge", Label: "모두 설치됨", tone: "ok", kind: controlBadge})
	if warn := countSetupWarnings(parts); warn > 0 {
		summary.Label = fmt.Sprintf("%d개 중 %d개가 다름", len(parts), warn)
		summary.tone = "warn"
		summary.Icon = "badge-warn"
	}
	kinds := missingSetupKinds(parts)
	install := b.small("setup-install-all", "core.settings-tab.setup-install-all", "모두 설치", "core.setup.install", map[string]any{"parts": kinds})
	install.Disabled = len(kinds) == 0
	install.Primary = true
	actions := []*SettingsControl{summary, install}
	actions = append(actions, b.small("setup-check", "core.settings-tab.setup-check", "다시 확인", "core.setup.check", nil))
	rows = append(rows, settingsRow{controls: actions, list: true})
	b.group("에이전트 연동", "에이전트가 이 애플리케이션을 배우고 다루게 하는 항목.", rows...)
}

// setupRow is the content of a row of the agent group.
type setupRow struct {
	name, state, file string
	failed            bool
	action            *SettingsControl
}

// countSetupWarnings is the number of setup parts that are not ok, the count of the summary of the agent group.
func countSetupWarnings(parts []SetupPart) int {
	warn := 0
	for _, part := range parts {
		if part.State != "ok" {
			warn++
		}
	}
	return warn
}
