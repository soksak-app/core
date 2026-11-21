package host

// The role handshake state of a tab (docs/spec/agent-roles.md#tab-role-state): the stored record of the tab in projects.json,
// the role files of its surface, and the answers of the role operations of the workspace store. Every operation of one surface
// runs under the lock of the workspace store, in arrival order, so each is judged against the state at its turn.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// fingerprintPattern is the form of a fingerprint: 16 lowercase hexadecimal characters.
var fingerprintPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)

// roleAnswer is the answer of every role operation and the value of the status core.tab.role: the members of the handshake,
// with the null members of a tab without a role. Seq rises at each change of this session of the host; the durable state is
// the stored record, so the status is rebuilt from it after a restart.
type roleAnswer struct {
	Role        any `json:"role"`
	Generation  any `json:"generation"`
	State       any `json:"state"`
	Seq         int `json:"seq"`
	Fingerprint any `json:"fingerprint"`
	Path        any `json:"path"`
}

// rolePath returns the path of the role file of a tab.
func (w *Workspace) rolePath(tab string) string {
	return filepath.Join(w.directory, "agents", tab, roleFileName)
}

// roleGet answers the status of the role of a tab: the record of the tab in projects.json decides every member, and a tab
// without a record answers the null members. A tab that no stored layout holds answers null itself.
func (w *Workspace) roleGet(tab string) (*roleAnswer, error) {
	projects, _, at, err := w.locateTab(tab)
	if err != nil {
		return nil, err
	}
	if projects == nil {
		return nil, nil
	}
	return w.answerOf(tab, at.record), nil
}

// answerOf builds the answer of the state of the stored record of a tab. A record is never partial
// (docs/spec/agent-roles.md#tab-role-state), so a present record holds every member.
func (w *Workspace) answerOf(tab string, record Record) *roleAnswer {
	if record == nil {
		return &roleAnswer{Seq: w.roleSeq[tab]}
	}
	// The record is validated (checkedTabRole), so every member read holds its form.
	fingerprint := record["fingerprint"].(string)
	state := "pending"
	if confirmed, ok := record["confirmedFingerprint"].(string); ok && confirmed == fingerprint {
		state = "ready"
	}
	return &roleAnswer{
		Role:        record["id"],
		Generation:  int(record["generation"].(float64)),
		State:       state,
		Seq:         w.roleSeq[tab],
		Fingerprint: fingerprint,
		Path:        w.rolePath(tab),
	}
}

// rolePut assigns, changes and clears the role of a tab, in the order that docs/spec/agent-roles.md#tab-role-state states: the
// role files are written under their temporary names first, the record is stored in projects.json second and the temporary
// files are renamed third. A failure of a step removes what the step wrote and leaves the earlier state, and a failure of the
// rename restores the earlier record. Setting the role that the tab already has, with the same definition, changes nothing.
func (w *Workspace) rolePut(tab string, role any) (*roleAnswer, error) {
	if w.roleRemoved[tab] {
		return nil, fmt.Errorf("tab %s was removed; its role cannot change", tab)
	}
	if role != nil {
		id, ok := role.(string)
		if !ok {
			return nil, fmt.Errorf("role %s is not an agent role identifier", jsonTextOf(role))
		}
		return w.roleChange(tab, id)
	}
	return w.roleClear(tab)
}

// jsonTextOf returns the compact JSON text of a value, for the refusal that names what it was given.
func jsonTextOf(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		return "?"
	}
	return string(data)
}

// roleChange assigns or changes the role of a tab to the role id, with the ordered steps and the idempotency of the spec.
func (w *Workspace) roleChange(tab, id string) (*roleAnswer, error) {
	// readRoles answers the role definitions of roles.json, already checked (roles.go).
	definitions, err := readRoles(filepath.Join(w.directory, "roles.json"))
	if err != nil {
		return nil, err
	}
	definition, has := definitions[id].(map[string]any)
	if !has {
		return nil, fmt.Errorf("unknown agent role %s", id)
	}
	// checkRoles of roles.json guarantees the two members; the reads are stated and refuse the impossible case.
	text, textOK := definition["text"].(string)
	ko, koOK := definition["ko"].(string)
	if !textOK || !koOK {
		return nil, fmt.Errorf("role %s holds no text or ko", id)
	}
	fingerprint := RoleFingerprint(id, text)
	projects, _, at, err := w.locateTab(tab)
	if err != nil {
		return nil, err
	}
	if projects == nil {
		return nil, fmt.Errorf("surface %q has no tab", tab)
	}
	if at.record != nil && at.record["id"] == id && at.record["fingerprint"] == fingerprint {
		// The same role with the same definition: no file is written, no generation changes and no message is sent.
		return w.answerOf(tab, at.record), nil
	}
	prepared, err := prepareRoleFile(w.directory, tab, id, text, ko)
	if err != nil {
		return nil, err
	}
	generation := 1.0
	if at.record != nil {
		if held, ok := at.record["generation"].(float64); ok && held >= 1 {
			generation = held + 1
		}
	}
	record := Record{"id": id, "generation": generation, "fingerprint": fingerprint, "confirmedFingerprint": nil}
	projects, err = w.storeTabRole(at, record)
	if err != nil {
		return nil, errors.Join(err, prepared.discard())
	}
	if err := prepared.commit(); err != nil {
		// The store of the change is undone, so the stored record keeps the earlier role; a restore that also fails reports
		// both errors (docs/spec/agent-roles.md#tab-role-state).
		if _, restoreErr := w.storeTabRole(at, earlierRoleOf(at)); restoreErr != nil {
			return nil, errors.Join(err, fmt.Errorf("projects.json %s: restore failed: %w", filepath.Join(w.directory, "projects.json"), restoreErr))
		}
		return nil, err
	}
	w.roleSeq[tab]++
	return w.answerOf(tab, record), nil
}

// earlierRoleOf answers the stored value of the member role that at names: the earlier record, or null.
func earlierRoleOf(at tabAt) any {
	if at.record != nil {
		return at.record
	}
	return nil
}

// roleClear removes the role of a tab: the record is stored as null first, then the folder of the role files of the surface is
// removed, so a tab whose record is null holds no role file.
func (w *Workspace) roleClear(tab string) (*roleAnswer, error) {
	projects, _, at, err := w.locateTab(tab)
	if err != nil {
		return nil, err
	}
	if projects == nil {
		return nil, fmt.Errorf("surface %q has no tab", tab)
	}
	if _, err := w.storeTabRole(at, nil); err != nil {
		return nil, err
	}
	if err := os.RemoveAll(filepath.Join(w.directory, "agents", tab)); err != nil {
		return nil, writeFailed(filepath.Join(w.directory, "agents", tab), err)
	}
	w.roleSeq[tab]++
	return w.answerOf(tab, nil), nil
}

// roleConfirm judges a confirmed fingerprint against the state of the tab at its turn: the current fingerprint in state
// pending stores the confirmation and gives ready, in state ready it changes nothing, and an earlier fingerprint is refused
// as stale with the path of the current role file (docs/spec/agent-roles.md#confirmation).
func (w *Workspace) roleConfirm(tab, fingerprint string) (*roleAnswer, error) {
	if !fingerprintPattern.MatchString(fingerprint) {
		return nil, fmt.Errorf("fingerprint %s is not 16 lowercase hexadecimal characters", fingerprint)
	}
	if w.roleRemoved[tab] {
		return nil, fmt.Errorf("tab %s has no role", tab)
	}
	projects, _, at, err := w.locateTab(tab)
	if err != nil {
		return nil, err
	}
	if projects == nil {
		return nil, fmt.Errorf("surface %q has no tab", tab)
	}
	if at.record == nil {
		return nil, fmt.Errorf("tab %s has no role", tab)
	}
	// The record is validated (checkedTabRole), so every member read holds its form.
	current := at.record["fingerprint"].(string)
	if confirmed, ok := at.record["confirmedFingerprint"].(string); ok && fingerprint == confirmed {
		return w.answerOf(tab, at.record), nil
	}
	if fingerprint != current {
		return nil, fmt.Errorf("stale fingerprint: read the role file again at %s", w.rolePath(tab))
	}
	stored := Record{"id": at.record["id"], "generation": at.record["generation"], "fingerprint": current, "confirmedFingerprint": fingerprint}
	if _, err := w.storeTabRole(at, stored); err != nil {
		return nil, err
	}
	w.roleSeq[tab]++
	return w.answerOf(tab, stored), nil
}

// roleRemove ends the role of a tab that left the layout: the folder of its role files is removed and every later role
// operation of that tab is refused (docs/spec/agent-roles.md#role-file, lifecycle).
func (w *Workspace) roleRemove(tab string) error {
	w.roleRemoved[tab] = true
	delete(w.roleSeq, tab)
	if err := os.RemoveAll(filepath.Join(w.directory, "agents", tab)); err != nil {
		return writeFailed(filepath.Join(w.directory, "agents", tab), err)
	}
	return nil
}

// locateTab reads projects.json and returns its projects, the record of the tab that holds its member role, and where the tab
// stands. A tab that no stored layout holds answers nil projects and a nil record without an error, so its callers refuse it
// with their own text.
func (w *Workspace) locateTab(tab string) ([]Record, Record, tabAt, error) {
	registry := filepath.Join(w.directory, "projects.json")
	projects, err := readProjects(registry)
	if err != nil {
		return nil, nil, tabAt{}, err
	}
	if err := checkProjects(registry, projects); err != nil {
		return nil, nil, tabAt{}, err
	}
	for index, project := range projects {
		root, hasRoot := project["root"].(string)
		if !hasRoot {
			return nil, nil, tabAt{}, invalidStoredLayout(registry, "a project record without a root")
		}
		spaces, hasSpaces := project["spaces"].([]any)
		if !hasSpaces {
			return nil, nil, tabAt{}, invalidStoredLayout(registry, "a project record without a spaces list")
		}
		for position, item := range spaces {
			space, isSpace := item.(map[string]any)
			if !isSpace {
				return nil, nil, tabAt{}, invalidStoredLayout(registry, "a space record that is not an object")
			}
			id, hasID := space["id"].(string)
			if !hasID {
				return nil, nil, tabAt{}, invalidStoredLayout(registry, "a space record without an id")
			}
			var found *foundTab
			visit := func(held foundTab) {
				if held.id == tab && found == nil {
					held := held
					found = &held
				}
			}
			if err := walkTabs(registry, space["layout"], visit); err != nil {
				return nil, nil, tabAt{}, err
			}
			if found != nil {
				record, err := checkedTabRole(registry, root, id, tab, found.record)
				if err != nil {
					return nil, nil, tabAt{}, err
				}
				return projects, found.record, tabAt{project: index, space: position, tab: *found, record: record}, nil
			}
		}
	}
	return nil, nil, tabAt{}, nil
}

// invalidStoredLayout refuses a projects.json whose form the role operations cannot read, naming the file and what they found.
func invalidStoredLayout(registry, what string) error {
	return fmt.Errorf("%s: %s", registry, what)
}

// checkedTabRole validates the member role of the record of a tab and answers the role record, or nil for the value null
// (docs/spec/agent-roles.md#tab-role-state). An absent member or a record of another form is refused with the text of the
// specification, which names the file, the project, the space and the tab.
func checkedTabRole(registry, root, space, tab string, tabRecord Record) (Record, error) {
	role, has := tabRecord["role"]
	if !has {
		return nil, fmt.Errorf("%s: project %s space %s: tab %s member role is missing", registry, root, space, tab)
	}
	if role == nil {
		return nil, nil
	}
	record, ok := role.(map[string]any)
	if !ok || len(record) != 4 {
		return nil, invalidTabRole(registry, root, space, tab)
	}
	id, idOK := record["id"].(string)
	generation, generationOK := record["generation"].(float64)
	fingerprint, fingerprintOK := record["fingerprint"].(string)
	confirmed, confirmedOK := record["confirmedFingerprint"].(string)
	confirmedNull := record["confirmedFingerprint"] == nil
	if !idOK || !roleIdentifierPattern.MatchString(id) {
		return nil, invalidTabRole(registry, root, space, tab)
	}
	if !generationOK || generation < 1 || generation != float64(int64(generation)) {
		return nil, invalidTabRole(registry, root, space, tab)
	}
	if !fingerprintOK || !fingerprintPattern.MatchString(fingerprint) {
		return nil, invalidTabRole(registry, root, space, tab)
	}
	if (!confirmedOK || !fingerprintPattern.MatchString(confirmed)) && !confirmedNull {
		return nil, invalidTabRole(registry, root, space, tab)
	}
	return record, nil
}

// roleIdentifierPattern is the identifier rule of a role definition (docs/spec/agent-roles.md#role-definitions).
var roleIdentifierPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

func invalidTabRole(registry, root, space, tab string) error {
	return fmt.Errorf("%s: project %s space %s: tab %s member role is invalid", registry, root, space, tab)
}

// tabAt names where a tab stands in projects.json: the index of its project, the position of its space in the spaces of the
// project, and the place of the tab record in the layout of that space.
type tabAt struct {
	project, space int
	tab            foundTab
	// record is the validated role record of the tab, or nil for the value null.
	record Record
}

// storeTabRole stores the member role of the tab that at names, as the whole record or null, and writes projects.json. The
// file is read again, so a change of another writer between the read and this write is kept.
func (w *Workspace) storeTabRole(at tabAt, role any) ([]Record, error) {
	registry := filepath.Join(w.directory, "projects.json")
	projects, err := readProjects(registry)
	if err != nil {
		return nil, writeFailed(registry, err)
	}
	if err := checkProjects(registry, projects); err != nil {
		return nil, writeFailed(registry, err)
	}
	if len(projects) <= at.project {
		return nil, writeFailed(registry, fmt.Errorf("project %d is gone", at.project))
	}
	spaces, hasSpaces := projects[at.project]["spaces"].([]any)
	if !hasSpaces {
		return nil, writeFailed(registry, fmt.Errorf("project %d holds no spaces list", at.project))
	}
	if len(spaces) <= at.space {
		return nil, writeFailed(registry, fmt.Errorf("space %d of the project is gone", at.space))
	}
	space, isSpace := spaces[at.space].(map[string]any)
	if !isSpace {
		return nil, writeFailed(registry, fmt.Errorf("space %d of the project is gone", at.space))
	}
	found, err := findTabInLayout(registry, space["layout"], at.tab.id)
	if err != nil {
		return nil, err
	}
	if found == nil {
		return nil, writeFailed(registry, fmt.Errorf("tab %s is gone", at.tab.id))
	}
	found["role"] = role
	if err := writeProjects(registry, projects); err != nil {
		return nil, writeFailed(registry, err)
	}
	return projects, nil
}

// foundTab is a tab record of a stored layout with its identifier.
type foundTab struct {
	id     string
	record Record
}

// walkTabs visits every tab record of the layout of a space, in the order of the stored tree, and refuses a stored layout
// whose form is not the tree of docs/spec/groups.md#storage with the file and what it found: a layout object without a state,
// a node that is not an object, a content card without a tab list, a tab without an identifier, a box without an inner cut and
// a cut without a kid list.
func walkTabs(registry string, layout any, visit func(found foundTab)) error {
	held, isLayout := layout.(map[string]any)
	if !isLayout {
		return invalidStoredLayout(registry, "a space record whose layout is not an object")
	}
	state, hasState := held["state"].(map[string]any)
	if !hasState {
		return invalidStoredLayout(registry, "a space layout without a state object")
	}
	var walk func(node any) error
	walk = func(node any) error {
		holder, isObject := node.(map[string]any)
		if !isObject {
			return invalidStoredLayout(registry, "a layout node that is not an object")
		}
		if holder["card"] != nil {
			data, hasData := holder["data"].(map[string]any)
			if !hasData {
				return invalidStoredLayout(registry, "a content card without a data object")
			}
			entries, hasTabs := data["tabs"].([]any)
			if !hasTabs {
				return invalidStoredLayout(registry, "a content card without a tab list")
			}
			for _, entry := range entries {
				tab, isTab := entry.(map[string]any)
				if !isTab {
					return invalidStoredLayout(registry, "a tab record that is not an object")
				}
				id, hasID := tab["id"].(string)
				if !hasID {
					return invalidStoredLayout(registry, "a tab record without an identifier")
				}
				visit(foundTab{id: id, record: tab})
			}
			return nil
		}
		if holder["box"] != nil {
			return walk(holder["inner"])
		}
		kids, hasKids := holder["kids"].([]any)
		if !hasKids {
			return invalidStoredLayout(registry, "a cut without a kid list")
		}
		for _, kid := range kids {
			pair, isPair := kid.(map[string]any)
			if !isPair {
				return invalidStoredLayout(registry, "a kid of a cut that is not an object")
			}
			if _, hasNode := pair["node"]; !hasNode {
				return invalidStoredLayout(registry, "a kid of a cut without a node")
			}
			if err := walk(pair["node"]); err != nil {
				return err
			}
		}
		return nil
	}
	return walk(state["root"])
}

// findTabInLayout returns the record of the tab id of the layout of a space, or nil when the layout holds no such tab; a
// stored layout of another form is refused.
func findTabInLayout(registry string, layout any, id string) (Record, error) {
	var found Record
	err := walkTabs(registry, layout, func(held foundTab) {
		if held.id == id && found == nil {
			found = held.record
		}
	})
	return found, err
}
