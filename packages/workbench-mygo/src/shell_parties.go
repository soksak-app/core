package workbench

import (
	"encoding/json"
	"fmt"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// registerParties registers the status core.parties and the party commands. A command that changes the parties stores the space
// before it replies (docs/spec/parties.md#commands).
func (s *Shell) registerParties() {
	s.registry.Status("core.parties", func() any { return s.partyRecords() })
	s.registry.Command("core.party.create", s.partyCommand("core.party.create", true))
	s.registry.Command("core.party.add", s.partyCommand("core.party.add", true))
	s.registry.Command("core.party.remove", s.partyCommand("core.party.remove", true))
	s.registry.Command("core.party.update", s.partyCommand("core.party.update", true))
	s.registry.Command("core.party.delete", s.partyCommand("core.party.delete", true))
	s.registry.Command("core.party.get", s.partyCommand("core.party.get", false))
	s.registry.Command("core.card.get", s.partyCommand("core.card.get", false))
}

// partyCommand returns the handler of a party command. changes tells whether the command changes the parties of the shown space.
func (s *Shell) partyCommand(name string, changes bool) Command {
	return func(params json.RawMessage) (any, error) {
		return s.runParty(name, changes, params)
	}
}

// partyRecords returns the records of the status core.parties of the shown plane. A window with no plane has no party.
func (s *Shell) partyRecords() []layout.Record {
	if s.plane == nil || s.parties == nil {
		return []layout.Record{}
	}
	records, err := s.parties.Records(s.plane)
	if err != nil {
		s.fail(err)
		return []layout.Record{}
	}
	return records
}

// runParty runs one party command over the shown plane and stores the space when the command changed the parties.
func (s *Shell) runParty(name string, changes bool, params json.RawMessage) (any, error) {
	if err := s.requirePlane(); err != nil {
		return nil, err
	}
	reply, err := s.parties.Run(s.plane, name, params)
	if err != nil {
		return nil, err
	}
	if changes {
		project := s.opened()
		if project == nil {
			return nil, fmt.Errorf("no project is shown")
		}
		if err := s.keepPlane(project); err != nil {
			return nil, err
		}
		s.storeSpaces(project)
		s.options.Invalidate()
	}
	return reply, nil
}

// reconcileParties corrects each party of the shown plane that the layout change affected (docs/spec/parties.md#changes-of-the-layout).
// The caller stores the plane with its parties and asks for the frame that sends core.parties to its watchers.
func (s *Shell) reconcileParties(change layout.LayoutChange) {
	if s.plane == nil || s.parties == nil {
		return
	}
	if _, err := s.parties.Reconcile(s.plane, change); err != nil {
		s.fail(fmt.Errorf("parties: %w", err))
	}
}

// restoreParties makes the parties of a space from its stored members, against the cards of its plane.
func (s *Shell) restoreParties(project *projectRecord, space layout.Space, plane *layout.Grid) error {
	raw, err := json.Marshal(space)
	if err != nil {
		return err
	}
	cards := []string{}
	for _, card := range plane.Cards() {
		cards = append(cards, card.ID)
	}
	stored, err := layout.ReadStoredParties(raw, project.Root, space.ID, cards)
	if err != nil {
		return err
	}
	palette, err := s.registry.declared.DefaultPartyPalette()
	if err != nil {
		return err
	}
	parties := layout.NewParties(palette, s.registry.declared.ChromeNumber("theme-rail-w", "px"))
	if err := parties.Restore(plane, stored); err != nil {
		return fmt.Errorf("parties: %w", err)
	}
	s.parties = parties
	return nil
}
