package workbench

import (
	"encoding/json"
	"fmt"
	"slices"
)

// The setup parts of the agents of the machine, the 에이전트 group of the settings window, the `core.setup` status and the
// `core.setup.check` and `core.setup.install` commands, as packages/workbench/setup-parts.js has them (docs/spec/settings.md#에이전트).
// The parts are read when the group is shown, and while it is shown when the window becomes the key window and after
// setup-changed, and by core.setup.check; no timer reads them, because the configuration file of the agent is rewritten by every
// agent session.

// setupKinds are the kinds of parts that the application installs; the path entry needs administrator rights and is installed in
// a terminal.
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
}

// SetupParts is the answer of setupState and setupInstall.
type SetupParts struct {
	Parts []SetupPart `json:"parts"`
}

// SetupStatus is the value of `core.setup`: Running is nil while no install runs.
type SetupStatus struct {
	Parts   []SetupPart `json:"parts"`
	Running []string    `json:"running"`
}

// SetupOperations are the setup parts of one window over its host calls. changed is called when the parts or the running
// install change, and fail shows a failed read or install through the error display, which writes it to the application log. A
// failure keeps the parts of the last read.
type SetupOperations struct {
	calls   *Calls
	changed func()
	fail    func(error)
	parts   []SetupPart
	running []string
	shown   bool
	// lastRead is the number of the last started read or install: a read that ends after a later one started does not replace its
	// parts.
	lastRead int
}

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
			p.changed()
		}
		answer(&parts, nil)
	})
}

// Install installs the kinds through setupInstall and keeps the parts that it answers; a failure is shown and answered. The host
// runs one setup operation at a time, so a second install of this window is refused with the text of the host and running names
// the install that runs.
func (p *SetupOperations) Install(kinds []string, answer func(*SetupParts, error)) {
	if p.running != nil {
		err := fmt.Errorf("another setup operation is running")
		p.fail(fmt.Errorf("setup: %w", err))
		answer(nil, err)
		return
	}
	p.running = kinds
	p.changed()
	p.lastRead++
	order := p.lastRead
	p.calls.Call("setupInstall", map[string]any{"parts": kinds}, func(value any, err error) {
		p.running = nil
		var parts SetupParts
		if err == nil {
			parts, err = decodeSetupParts(value)
		}
		if err != nil {
			p.changed()
			p.fail(fmt.Errorf("setup: %w", err))
			answer(nil, err)
			return
		}
		if order == p.lastRead {
			p.parts = parts.Parts
		}
		p.changed()
		answer(&parts, nil)
	})
}

// Show records whether the 에이전트 group is shown; showing it reads the parts.
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

// decodeSetupParts reads the answer of setupState or setupInstall; a part without a list is an error of the host.
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
}

// setupNames are the names of the setup parts, and setupStates the texts of their states.
var (
	setupNames  = map[string]string{"path": "명령 경로", "skill": "스킬", "mcp": "MCP 등록"}
	setupStates = map[string]string{"ok": "설치됨", "absent": "설치 안 됨", "differs": "다름"}
)

// buildSetup adds the 에이전트 group: one row per part with its name, file and state, the install step of a missing path entry,
// 설치 while a skill or mcp part is not ok, and 다시 확인. The error text of a part that cannot be read goes through the error
// display path.
func (s *Shell) buildSetup(b *settingsBuilder) {
	parts := s.setupOperations.Parts()
	rows := make([]settingsRow, 0, len(parts)+2)
	for _, part := range parts {
		key := "setup:" + part.Part + ":" + part.File
		state := setupStates[part.State]
		if part.State == "missing" {
			state = setupStates[part.Reason]
		}
		if part.State == "error" {
			state = part.Error
			s.errors.Show(key, part.Error, "")
		}
		step := ""
		if part.Part == "path" && part.State == "missing" {
			step = part.Step
		}
		// The label is the text of the row in document order, as the page reports the textContent of its row.
		control := b.add(SettingsControl{Name: "core.settings-modal.setup", Key: text(key), Label: setupNames[part.Part] + state + part.File + step,
			kind: controlSetup, setup: &setupRow{name: setupNames[part.Part], state: state, file: part.File, step: step, failed: part.State == "error"}})
		rows = append(rows, settingsRow{controls: []*SettingsControl{control}, list: true})
	}
	if len(parts) == 0 {
		rows = append(rows, settingsRow{description: "이 컴퓨터에서 설정할 에이전트 항목이 없습니다."})
	}
	actions := []*SettingsControl{}
	if kinds := missingSetupKinds(parts); len(kinds) > 0 {
		actions = append(actions, b.button("setup-install", "core.settings-modal.setup-install", "설치", "core.setup.install", map[string]any{"parts": kinds}))
	}
	actions = append(actions, b.button("setup-check", "core.settings-modal.setup-check", "다시 확인", "core.setup.check", nil))
	rows = append(rows, settingsRow{controls: actions, list: true})
	b.group("에이전트", "에이전트가 이 애플리케이션을 배우고 다루게 하는 항목. 명령 경로는 관리자 권한이 필요하므로 터미널에서 보이는 명령으로 설치한다.", rows...)
}

// setupRow is the content of a row of the 에이전트 group.
type setupRow struct {
	name, state, file, step string
	failed                  bool
}
