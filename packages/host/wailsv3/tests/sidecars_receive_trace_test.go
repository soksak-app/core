package host_test

import (
	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"reflect"
	"testing"
)

func TestHandledImageRecordsItsReceiptOnce(t *testing.T) {
	receipts := 0
	handled := host.ReceiveSidecarMessage(func() { receipts++ }, func() bool { return true })
	if !handled {
		t.Fatal("image was not consumed by native dispatch")
	}
	if receipts != 1 {
		t.Fatalf("handled image receipt count: %d, want 1", receipts)
	}
}

func TestOrdinaryMessageKeepsItsReceiptAndPageDelivery(t *testing.T) {
	receipts := 0
	handled := host.ReceiveSidecarMessage(func() { receipts++ }, func() bool { return false })
	if handled {
		t.Fatal("ordinary message was consumed before page delivery")
	}
	if receipts != 1 {
		t.Fatalf("ordinary message receipt count: %d, want 1", receipts)
	}
}

func TestReceiptPrecedesNativeDispatch(t *testing.T) {
	var order []string
	host.ReceiveSidecarMessage(func() { order = append(order, "receive") }, func() bool {
		order = append(order, "image")
		return true
	})
	if !reflect.DeepEqual(order, []string{"receive", "image"}) {
		t.Fatalf("dispatch order: %v", order)
	}
}
