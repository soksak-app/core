package workbench

import "fmt"

// The notices of the outdated persistent services (docs/spec/persistent-services.md#updates). The web workbench shows the same
// notice through packages/workbench/sidecar-outdated.js. One warning per service is shown through the notice store, and it is
// withdrawn when the service leaves the list of outdated services.

// OutdatedNotices keeps the notice that each shown outdated service has in the notice store.
type OutdatedNotices struct {
	store *ShownErrors
	// shown maps each outdated service that has a shown notice to the id of that notice.
	shown map[string]string
}

// NewOutdatedNotices returns the notices of the outdated services of a window that shows them in store.
func NewOutdatedNotices(store *ShownErrors) *OutdatedNotices {
	return &OutdatedNotices{store: store, shown: map[string]string{}}
}

// outdatedOrigin is the origin of the notice of a service: each service has at most one shown notice.
func outdatedOrigin(sidecar string) string { return "sidecar-outdated:" + sidecar }

// outdatedNotice returns the fields and the source of the notice of one outdated service. A service that sent no version is named
// without one, and a sidecar that is no longer declared names its installed version as null, as the web notice does.
func outdatedNotice(service OutdatedSidecar) (noticeFields, NoticeSource) {
	installed := "null"
	if service.Installed != nil {
		installed = *service.Installed
	}
	var title string
	if service.Running == nil {
		title = fmt.Sprintf("%s 서비스가 버전 없이 실행 중이고 설치된 버전은 %s다", service.Sidecar, installed)
	} else {
		title = fmt.Sprintf("%s %s이 실행 중이고 설치된 버전은 %s다", service.Sidecar, *service.Running, installed)
	}
	text := fmt.Sprintf("세션 %d개가 이 서비스를 쓰고 있다. 세션이 모두 끝나면 서비스가 자동으로 교체된다. 교체를 누르면 세션 %d개가 끝나고 설치된 버전이 시작된다.",
		service.Sessions, service.Sessions)
	action := NoticeAction{Label: "교체", Command: "core.plugins.replace", Params: map[string]any{"sidecar": service.Sidecar}}
	return noticeFields{Kind: "warning", Title: title, Text: text, Action: &action}, NoticeSource{Kind: "core"}
}

// Reconcile shows the notice of each service of outdated under its origin, so a service that is still outdated has its notice rewritten
// with the list's values (docs/spec/notifications.md#notices), and withdraws the notice of each shown service that is no longer in
// outdated. A withdrawn notice closes its toast, and its entry stays in the center, read.
func (o *OutdatedNotices) Reconcile(outdated []OutdatedSidecar) {
	listed := make(map[string]bool, len(outdated))
	for _, service := range outdated {
		listed[service.Sidecar] = true
		fields, source := outdatedNotice(service)
		o.shown[service.Sidecar] = o.store.NotifyFrom(outdatedOrigin(service.Sidecar), fields, source)
	}
	for sidecar, id := range o.shown {
		if !listed[sidecar] {
			o.store.WithdrawNotice(id)
			delete(o.shown, sidecar)
		}
	}
}

// refreshOutdated reads the outdated persistent services of the host, shows their notices and then runs done. Each read of the list
// goes through it, so the notices follow the list at start and at each change of the services.
func (s *Shell) refreshOutdated(done func()) {
	s.pluginOperations.RefreshOutdated(func() {
		s.outdatedNotices.Reconcile(s.pluginOperations.Status().Outdated)
		done()
	})
}
