package layout

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
)

// The spaces of a stored project record (docs/spec/projects.md#persistence): the functions that read and change the spaces, the
// active space and the space counter of one record, as packages/workbench/spaces.js does.

// Space is a space of a project: its id, its title and its stored layout.
type Space struct {
	ID     string          `json:"id"`
	Title  string          `json:"title"`
	Layout json.RawMessage `json:"layout"`
}

// Project is a project record of projects.json. The members that the space functions read and change are fields, and Rest holds
// every other member of the record as it is stored.
type Project struct {
	ID            string
	Named         int
	Spaces        []Space
	ActiveSpaceID string
	Rest          map[string]json.RawMessage
}

// UnmarshalJSON reads a project record. The members id, named, spaces and activeSpaceId are required.
func (p *Project) UnmarshalJSON(text []byte) error {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(text, &members); err != nil {
		return err
	}
	read := func(key string, out any) error {
		raw, ok := members[key]
		if !ok {
			return errors.New("a project record has no " + key)
		}
		delete(members, key)
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("project record member %s: %w", key, err)
		}
		return nil
	}
	*p = Project{}
	for _, member := range []struct {
		key string
		out any
	}{{"id", &p.ID}, {"named", &p.Named}, {"spaces", &p.Spaces}, {"activeSpaceId", &p.ActiveSpaceID}} {
		if err := read(member.key, member.out); err != nil {
			return err
		}
	}
	p.Rest = members
	return nil
}

// MarshalJSON writes the project record with every member it was read with.
func (p Project) MarshalJSON() ([]byte, error) {
	members := make(map[string]any, len(p.Rest)+4)
	for key, value := range p.Rest {
		members[key] = value
	}
	spaces := p.Spaces
	if spaces == nil {
		spaces = []Space{}
	}
	members["id"], members["named"], members["spaces"], members["activeSpaceId"] = p.ID, p.Named, spaces, p.ActiveSpaceID
	return json.Marshal(members)
}

// SpaceIn is the space id of p. An id that is not a space of p is an error.
func SpaceIn(p *Project, id string) (*Space, error) {
	for i := range p.Spaces {
		if p.Spaces[i].ID == id {
			return &p.Spaces[i], nil
		}
	}
	return nil, errors.New("Unknown space: " + id)
}

// AppendSpace adds a space with id and layout after the others, names it by the next value of the counter, makes it active and
// returns it.
func AppendSpace(p *Project, id string, layout json.RawMessage) Space {
	p.Named++
	space := Space{ID: id, Title: "SPACE" + strconv.Itoa(p.Named), Layout: layout}
	p.Spaces = append(p.Spaces, space)
	p.ActiveSpaceID = space.ID
	return space
}

// Closing is what closing a space does: its index, and the space that becomes active when it is the active space, or nil when the
// active space stays.
type Closing struct {
	At   int    `json:"at"`
	Next *Space `json:"next"`
}

// ClosingSpace is what closing the space id does, or nil when id is the only space, which is not closed. An unknown id is an error.
func ClosingSpace(p *Project, id string) (*Closing, error) {
	if len(p.Spaces) == 1 {
		return nil, nil
	}
	at := -1
	var rest []Space
	for i, s := range p.Spaces {
		if s.ID == id {
			if at < 0 {
				at = i
			}
			continue
		}
		rest = append(rest, s)
	}
	if at < 0 {
		return nil, errors.New("Unknown space: " + id)
	}
	closing := &Closing{At: at}
	if id == p.ActiveSpaceID {
		next := rest[min(at, len(rest)-1)]
		closing.Next = &next
	}
	return closing, nil
}

// RemoveSpace closes the space id as ClosingSpace describes and returns it, or nil when it is the only space.
func RemoveSpace(p *Project, id string) (*Space, error) {
	closing, err := ClosingSpace(p, id)
	if closing == nil || err != nil {
		return nil, err
	}
	removed := p.Spaces[closing.At]
	p.Spaces = append(p.Spaces[:closing.At:closing.At], p.Spaces[closing.At+1:]...)
	if closing.Next != nil {
		p.ActiveSpaceID = closing.Next.ID
	}
	return &removed, nil
}

// RenameSpace renames the space id. An unknown id is an error.
func RenameSpace(p *Project, id, title string) error {
	space, err := SpaceIn(p, id)
	if err != nil {
		return err
	}
	space.Title = title
	return nil
}

// SpaceTabIDs is the tab ids of the layouts of all spaces of p, in the order of the spaces, their cards and their tabs.
func SpaceTabIDs(p *Project) ([]string, error) {
	out := []string{}
	for _, space := range p.Spaces {
		var layout struct {
			State struct {
				Cards []struct {
					Data *struct {
						Tabs []struct {
							ID string `json:"id"`
						} `json:"tabs"`
					} `json:"data"`
				} `json:"cards"`
			} `json:"state"`
		}
		if err := json.Unmarshal(space.Layout, &layout); err != nil {
			return nil, fmt.Errorf("space %s: %w", space.ID, err)
		}
		for _, card := range layout.State.Cards {
			// A seat card has null data, so it has no tabs.
			if card.Data == nil {
				continue
			}
			for _, tab := range card.Data.Tabs {
				out = append(out, tab.ID)
			}
		}
	}
	return out, nil
}
