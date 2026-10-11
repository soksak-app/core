package host

// The crash reports of the system (docs/spec/logging.md#automatic-entrances): when the application crashes, the system writes a
// report into the folder of the crash reports of the user, and the next start of the host announces each report of the
// application once as the event `host.crash.found`.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

const (
	// CrashReportLimit is the number of reports that one lookup reads: the newest reports of the application by name, which
	// carries the date and the time.
	CrashReportLimit = 64
	// crashReportBytes is the largest size in bytes of a report that the lookup reads.
	crashReportBytes = 16 << 20
	// crashLedgerName is the file of the logs folder that lists the reports that were announced.
	crashLedgerName = "crash-found.txt"
)

// CrashLedgerPath is the file under the logs folder of config that lists the announced crash reports, one path in each line.
func CrashLedgerPath(config string) string {
	return filepath.Join(config, "logs", crashLedgerName)
}

// crashHeader is the first line of a report: the name of the process and the time of the crash.
type crashHeader struct {
	Name      string `json:"app_name"`
	Timestamp string `json:"timestamp"`
}

// AnnounceCrashReports stores the event `host.crash.found` (`path`, `pid`, `time`) for each report of the application in
// directory that the ledger file does not list, and lists it there. A report is a file `<application>-<date>.ips` whose header names
// the application. The lookup reads the newest CrashReportLimit reports. A report that cannot be read is an error that names
// the file; it is listed too, so the error is reported once. A folder that does not exist has no reports. The result joins
// the errors.
func AnnounceCrashReports(directory, ledger, application string) error {
	entries, err := os.ReadDir(directory)
	if errors.Is(err, fs.ErrNotExist) {
		// silent: the system creates its folder of crash reports with the first report, so a missing folder holds no report.
		return nil
	}
	if err != nil {
		return fmt.Errorf("crash reports: %w", err)
	}
	announced, err := readCrashLedger(ledger)
	if err != nil {
		return err
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), application+"-") && strings.HasSuffix(entry.Name(), ".ips") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if len(names) > CrashReportLimit {
		names = names[len(names)-CrashReportLimit:]
	}
	var failures []error
	var kept []string
	for _, name := range names {
		path := filepath.Join(directory, name)
		kept = append(kept, path)
		if announced[path] {
			continue
		}
		pid, stamp, err := readCrashReport(path, application)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		if pid != 0 {
			EmitHost(LevelWarn, "host.crash.found", map[string]any{"path": path, "pid": pid, "time": stamp})
		}
	}
	// The ledger lists only the reports that the next lookup can still read, so it does not grow with the history of the folder.
	if err := os.WriteFile(ledger, []byte(strings.Join(append(kept, ""), "\n")), 0o600); err != nil {
		failures = append(failures, fmt.Errorf("crash reports: %w", err))
	}
	return errors.Join(failures...)
}

// readCrashLedger reads the paths of the announced reports. A missing file lists none.
func readCrashLedger(ledger string) (map[string]bool, error) {
	data, err := os.ReadFile(ledger)
	if errors.Is(err, fs.ErrNotExist) {
		// silent: the ledger is created by the first lookup, so a missing file lists no announced report.
		return map[string]bool{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("crash reports: %w", err)
	}
	announced := map[string]bool{}
	for _, line := range strings.Split(string(data), "\n") {
		if line != "" {
			announced[line] = true
		}
	}
	return announced, nil
}

// readCrashReport reads the process identifier and the time of the report at path. A report whose header names another
// application returns the identifier 0 and no error.
func readCrashReport(path, application string) (int, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, "", fmt.Errorf("crash report %s: %w", path, err)
	}
	defer file.Close()
	reader := bufio.NewReader(io.LimitReader(file, crashReportBytes))
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return 0, "", fmt.Errorf("crash report %s: the header line cannot be read: %w", path, err)
	}
	var header crashHeader
	if err := json.Unmarshal(line, &header); err != nil {
		return 0, "", fmt.Errorf("crash report %s: the header is not JSON: %w", path, err)
	}
	if header.Name != application {
		// silent: a report of another process whose name starts with the name of the application is not a report of it.
		return 0, "", nil
	}
	if header.Timestamp == "" {
		return 0, "", fmt.Errorf("crash report %s: the header has no timestamp", path)
	}
	var body struct {
		Pid *int `json:"pid"`
	}
	if err := json.NewDecoder(reader).Decode(&body); err != nil {
		return 0, "", fmt.Errorf("crash report %s: the body has no readable pid: %w", path, err)
	}
	if body.Pid == nil || *body.Pid <= 0 {
		return 0, "", fmt.Errorf("crash report %s: the body has no pid", path)
	}
	return *body.Pid, header.Timestamp, nil
}

// AnnounceCrashReportsAtStart looks up the crash reports of this application in the folder that the system names and
// announces them. The application is the name of the executable.
func AnnounceCrashReportsAtStart(config string) error {
	system, err := platform.Current()
	if err != nil {
		return fmt.Errorf("crash reports: %w", err)
	}
	directory, err := system.DiagnosticReportsDirectory()
	if err != nil {
		return fmt.Errorf("crash reports: %w", err)
	}
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("crash reports: %w", err)
	}
	return AnnounceCrashReports(directory, CrashLedgerPath(config), filepath.Base(executable))
}
