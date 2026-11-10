package workbench

import (
	"encoding/json"
	"fmt"
	"slices"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The question about a modified tab (docs/spec/plugins.md#tab-reports): core.tab.close, core.card.close and core.space.close do not
// close a modified tab, the selection layer asks whether to save, discard or keep it, and the command answers closed false.

// closed is the answer of a close command.
func closed(done bool) map[string]bool { return map[string]bool{"closed": done} }

// tabModified tells whether the surface of tab holds changes that are not saved.
func (s *Shell) tabModified(tab string) bool {
	report := s.surfaces.reports[tab]
	return report != nil && report.Modified
}

// modifiedAnswers are the names of the answers of the question about a modified tab.
type modifiedAnswers struct{ save, discard, keep string }

// The answers when a tab, a card, a space or the window closes, and when a plugin change applies
// (docs/spec/installation.md#applying-a-change).
var (
	closeAnswers = modifiedAnswers{save: "저장하고 닫기", discard: "저장하지 않고 닫기", keep: "닫지 않기"}
	applyAnswers = modifiedAnswers{save: "저장하고 적용", discard: "저장하지 않고 적용", keep: "적용하지 않기"}
)

// askModified asks about the modified tab of card with the answers words and gives answered true when its changes were saved or
// discarded. The layer stands at the button of the tab, and at the card when its head shows no such button.
func (s *Shell) askModified(card string, tab layout.Tab, words modifiedAnswers, answered func(settled bool)) {
	save := ""
	if owner := s.loadedPlugin(tab.Plugin); owner != nil {
		save = owner.Save
	}
	items := []pickerItem{{Key: "discard", Name: words.discard}, {Key: "keep", Name: words.keep}}
	if save != "" {
		items = slices.Insert(items, 0, pickerItem{Key: "save", Name: words.save})
	}
	layer := s.openPicker(s.tabName(tab)+" 탭에 저장하지 않은 변경이 있습니다", items, func(key string) error {
		switch key {
		case "keep":
			answered(false)
		case "discard":
			answered(true)
		default:
			s.saveTab(tab.ID, save, answered)
		}
		return nil
	})
	layer.anchor = "core.card.tab/" + tab.ID
	if _, drawn := layer.drawn[layer.anchor]; !drawn {
		layer.anchor = "core.card/" + card
	}
	// Closing the layer keeps the tab, as the keep answer does.
	layer.dismiss = func() { answered(false) }
}

// saveTab runs the save command of a surface. The answer is true when the command succeeds and the tab is no longer modified.
func (s *Shell) saveTab(tab, save string, answered func(settled bool)) {
	s.registry.RunOn(save, json.RawMessage(`{}`), tab, func(_ any, err error) {
		present := s.cardOfTab(tab) != "" // The tab leaves with its plane while the view saves, and then nothing is left to close.
		failure := ""
		switch {
		case err != nil:
			failure = fmt.Sprintf("저장하지 못했습니다 · %s: %v", save, err)
		case present && s.tabModified(tab):
			failure = fmt.Sprintf("저장하지 못했습니다 · %s left the tab modified", save)
		}
		switch {
		case failure == "":
		case present:
			// The failure is the error of the tab, which core.grid reports and its card shows and records, as reportError of
			// packages/workbench/plane.js reports it (docs/spec/plugins.md#tab-reports).
			s.report(tab).Error = failure
			s.options.Invalidate()
			s.settle()
		default:
			// The tab left with its plane, so no card shows the failure, which lost the work of the person.
			s.errors.Show(tab, failure, "")
			s.settle()
		}
		answered(failure == "" && present)
	})
}

// askedCloseTab closes the tab id when it is not modified and asks about it otherwise. It tells whether the tab closed.
func (s *Shell) askedCloseTab(id string) (bool, error) {
	tab, err := s.tabOf(id)
	if err != nil {
		return false, err
	}
	if !s.tabModified(id) {
		return true, s.closeTab(id)
	}
	s.askModified(s.cardOfTab(id), tab, closeAnswers, func(settled bool) {
		if settled {
			s.showFailure(s.closeTab(id))
		}
	})
	return false, nil
}

// showFailure shows err when there is one.
func (s *Shell) showFailure(err error) {
	if err != nil {
		s.fail(err)
	}
}

// askedCloseCard closes the card id when no tab of it is modified. Otherwise it asks about the first modified tab; once that tab is
// closed, closing the card asks about the next one or closes the card. It tells whether the card closed.
func (s *Shell) askedCloseCard(id string) (bool, error) {
	if err := s.paneCard(id); err != nil {
		return false, err
	}
	if !s.plane.CanClose(id) {
		return false, fmt.Errorf("card %s cannot close", id)
	}
	data, err := s.cardData(id)
	if err != nil {
		return false, err
	}
	if data != nil {
		for _, tab := range data.TabList() {
			if s.tabModified(tab.ID) {
				s.askModified(id, tab, closeAnswers, func(settled bool) {
					if !settled {
						return
					}
					if err := s.closeTab(tab.ID); err != nil {
						s.fail(err)
						return
					}
					if _, still := s.plane.Card(id); still {
						_, err := s.askedCloseCard(id)
						s.showFailure(err)
					}
				})
				return false, nil
			}
		}
	}
	return true, s.closeCard(id)
}

// settleModified asks about each modified tab of the plane in turn with the answers words, and gives done false when a tab is kept. The
// library shows no space, so the window has no tab to ask about.
func (s *Shell) settleModified(words modifiedAnswers, done func(settled bool)) {
	type asked struct {
		card string
		tab  layout.Tab
	}
	var modified []asked
	if s.plane != nil && !s.browsing {
		for _, card := range s.plane.Cards() {
			data, err := s.cardData(card.ID)
			if err != nil || data == nil {
				continue // A card without tabs has nothing to ask, and the plane shows the error of a card that does not read.
			}
			for _, tab := range data.TabList() {
				if s.tabModified(tab.ID) {
					modified = append(modified, asked{card.ID, tab})
				}
			}
		}
	}
	var next func(index int)
	next = func(index int) {
		if index == len(modified) {
			done(true)
			return
		}
		s.askModified(modified[index].card, modified[index].tab, words, func(settled bool) {
			if !settled {
				done(false)
				return
			}
			next(index + 1)
		})
	}
	next(0)
}

// closeWindowAsked answers a close request of the window: a modified tab that the person keeps keeps the window open, and the host hears
// of it, because the request may belong to a quit.
func (s *Shell) closeWindowAsked() {
	s.settleModified(closeAnswers, func(settled bool) {
		// The close is decided here, so it waits for the commands that run now and for none that starts later (afterCommands).
		mark := s.commandMark()
		if !settled {
			cids := s.events.BeginOperation("workbench.window.operation", map[string]any{"action": "close_kept"})
			s.calls.Caused(cids).CallInOrder("workspace", "windowCloseKept", nil, func(_ any, err error) {
				if err != nil {
					s.fail(err)
				}
			})
			return
		}
		s.keep()
		s.saveGeometry(func(err error) {
			if err != nil {
				s.fail(err)
			}
			s.flushTabs(func() {
				// The call ends the workbench of the window, so its first event leaves before the call, and it waits for the answers
				// that the window owed when the close was decided, as the answer of the pick that closes it (afterCommands).
				s.afterCommands(mark, func() {
					cids := s.events.BeginOperation("workbench.window.operation", map[string]any{"action": "close"})
					s.events.Flush(func() {
						s.calls.Caused(cids).CallInOrder("workspace", "windowClose", nil, func(_ any, err error) {
							if err != nil {
								s.fail(err)
							}
						})
					})
				})
			})
		})
	})
}
