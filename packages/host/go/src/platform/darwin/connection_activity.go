//go:build darwin

package darwin

// The activity that the host holds while a connection of its endpoint is open (connection_activity.h).

func (implementation) HoldConnectionActivity(held bool) error {
	native.SpConnectionActivityHold(held)
	return nil
}
