package workbench

import "github.com/egoist/mygo/ui"

// The last pointer sequence of the workbench, the value of the status core.pointer. The root of the workbench observes each press
// and release, which reach it whatever element takes them, and names what stands under the pointer from the element tree of the
// last frame (docs/spec/exposure.md#workbench-statuses).

// noElement is the name of a target that the element tree does not hold.
const noElement = "unknown"

// PointerStatus is the value of the status core.pointer. A press increments Sequence and the other members start anew.
type PointerStatus struct {
	Sequence         int     `json:"sequence"`
	Down             *string `json:"down"`
	Up               *string `json:"up"`
	PressedConnected *bool   `json:"pressedConnected"`
	Click            *string `json:"click"`
}

// PointerSequence holds the last pointer sequence of a window.
type PointerSequence struct {
	elements Elements
	changed  func()
	fail     func(error)
	status   PointerStatus
	// pressed is the path of the element of the press, from the root of the tree to the element, empty outside the tree.
	pressed []ui.ElementNode
}

// NewPointerSequence makes the sequence of the window with the elements. changed runs on each change of its status, and fail
// takes a tree that cannot be read.
func NewPointerSequence(elements Elements, changed func(), fail func(error)) *PointerSequence {
	return &PointerSequence{elements: elements, changed: changed, fail: fail}
}

// Observe takes the input of the element that holds the workbench at the origin of the window (ui.Element.ObserveInput).
func (p *PointerSequence) Observe(ev ui.InputEvent) {
	switch ev.Kind {
	case ui.InputPointerDown:
		p.down(ev)
	case ui.InputPointerUp:
		p.up(ev)
	}
}

func (p *PointerSequence) tree() []ui.ElementNode {
	tree, err := p.elements.ElementTree()
	if err != nil {
		p.fail(err)
		return nil
	}
	return tree
}

func (p *PointerSequence) down(ev ui.InputEvent) {
	p.pressed = pathAt(p.tree(), ev.X, ev.Y)
	name := pathName(p.pressed)
	p.status = PointerStatus{Sequence: p.status.Sequence + 1, Down: &name}
	p.changed()
}

func (p *PointerSequence) up(ev ui.InputEvent) {
	tree := p.tree()
	path := pathAt(tree, ev.X, ev.Y)
	name := pathName(path)
	p.status.Up = &name
	lost := false
	if len(p.pressed) > 0 {
		connected := holds(tree, p.pressed[len(p.pressed)-1].ID)
		p.status.PressedConnected, lost = &connected, !connected
	}
	p.changed()
	if ev.Button != 0 || lost {
		return
	}
	click := pathName(sharedPath(p.pressed, path))
	p.status.Click = &click
	p.changed()
}

// pathAt returns the path of the innermost element at the point, from the root of the tree. The elements drawn later stand over
// the elements drawn before, and an element can stand outside the box of the element around it.
func pathAt(nodes []ui.ElementNode, x, y float32) []ui.ElementNode {
	for i := len(nodes) - 1; i >= 0; i-- {
		node := nodes[i]
		if inner := pathAt(node.Children, x, y); inner != nil {
			return append([]ui.ElementNode{node}, inner...)
		}
		if box := node.Bounds; x >= box.X && x < box.X+box.W && y >= box.Y && y < box.Y+box.H {
			return []ui.ElementNode{node}
		}
	}
	return nil
}

// pathName returns the element name nearest to the end of the path, and without one the role of its last element, the tag of
// this host.
func pathName(path []ui.ElementNode) string {
	if len(path) == 0 {
		return noElement
	}
	for i := len(path) - 1; i >= 0; i-- {
		if name := elementName(path[i].Key); name != "" {
			return name
		}
	}
	return AriaRole(path[len(path)-1].Role)
}

// sharedPath returns the path of the nearest element around the ends of both paths.
func sharedPath(a, b []ui.ElementNode) []ui.ElementNode {
	n := 0
	for n < len(a) && n < len(b) && a[n].ID == b[n].ID {
		n++
	}
	return a[:n]
}

func holds(nodes []ui.ElementNode, id uint64) bool {
	for _, node := range nodes {
		if node.ID == id || holds(node.Children, id) {
			return true
		}
	}
	return false
}

// Click records the click of the element name, which a key or an action of assistive technology gives without a press. The click
// of a press has its record already.
func (p *PointerSequence) Click(name string) {
	if p.status.Click != nil && *p.status.Click == name {
		return
	}
	p.status.Click = &name
	p.changed()
}

// Status is the value of the status core.pointer.
func (p *PointerSequence) Status() PointerStatus { return p.status }
