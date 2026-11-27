package host

// The account runs and account homes of a plugin (docs/spec/native-surfaces.md#account-runs): the workbench runs the account
// programs of a plugin for the settings tab, where no view of the plugin runs, in the data folder of the plugin.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/soksak-app/core/packages/sok/go/src"
)

var (
	// accountIdentifier is the form of the identifier of an account home.
	accountIdentifier = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
	// accountPluginIdentifier is the form of a plugin identifier, so the folder of a plugin never leaves the data folders.
	accountPluginIdentifier = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
)

// accountHomesFolder is the folder of the account homes in the data folder of a plugin.
const accountHomesFolder = "accounts"

// AccountRunRequest is the argument of accountRun: the plugin, its programs declaration, the run that the workbench chose, the
// declared name and the argument texts.
type AccountRunRequest struct {
	Plugin   string          `json:"plugin"`
	Programs json.RawMessage `json:"programs"`
	Run      uint64          `json:"run"`
	Name     string          `json:"name"`
	Args     []string        `json:"args"`
}

// AccountRunCancelRequest is the argument of accountRunCancel: the plugin and the run that ends.
type AccountRunCancelRequest struct {
	Plugin string `json:"plugin"`
	Run    uint64 `json:"run"`
}

// AccountHomesRequest is the argument of accountHomes.
type AccountHomesRequest struct {
	Plugin string `json:"plugin"`
}

// AccountHomeRequest is the argument of accountHomeCreate and accountHomeRemove.
type AccountHomeRequest struct {
	Plugin string `json:"plugin"`
	ID     string `json:"id"`
}

// AccountHomesReply is the answer of accountHomes: the absolute path of accounts/ and the names of its folders in byte order.
type AccountHomesReply struct {
	Folder string   `json:"folder"`
	Names  []string `json:"names"`
}

// checkAccountRun checks an account run against the declarations of plugin: the refusals of a view run, and a program that is a
// plugin path or a bare name, because the run has no project folder. The working directory is the data folder of the plugin.
func checkAccountRun(declared map[string]programDeclaration, plugin, name string, args []string, dataFolder string) (programRunSpec, error) {
	spec, err := checkDeclaredRun(declared, plugin, name, args, dataFolder)
	if err != nil {
		return programRunSpec{}, err
	}
	if !strings.HasPrefix(spec.Program, sok.ProgramPluginPrefix) && strings.Contains(spec.Program, "/") {
		return programRunSpec{}, fmt.Errorf("program %s must be a plugin path or a bare name in an account run", name)
	}
	return spec, nil
}

// accountHomesOf returns the folder accounts/ of the data folder of plugin, which it does not create.
func accountHomesOf(configDir, plugin string) (string, error) {
	if !accountPluginIdentifier.MatchString(plugin) {
		return "", fmt.Errorf("account home: plugin %s is not a plugin identifier", plugin)
	}
	if !filepath.IsAbs(configDir) {
		return "", fmt.Errorf("account home: configuration directory %q is not absolute", configDir)
	}
	return filepath.Join(configDir, pluginData, plugin, accountHomesFolder), nil
}

// accountHomeOf returns the home of the account id of plugin.
func accountHomeOf(configDir, plugin, id string) (string, error) {
	folder, err := accountHomesOf(configDir, plugin)
	if err != nil {
		return "", err
	}
	if !accountIdentifier.MatchString(id) {
		return "", fmt.Errorf("account home %s is not an account identifier", id)
	}
	return filepath.Join(folder, id), nil
}

// AccountHomes lists the folders of accounts/ of the data folder of plugin; a missing accounts/ holds none.
func AccountHomes(configDir, plugin string) (AccountHomesReply, error) {
	folder, err := accountHomesOf(configDir, plugin)
	if err != nil {
		return AccountHomesReply{}, err
	}
	entries, err := os.ReadDir(folder)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return AccountHomesReply{}, fmt.Errorf("account homes: %w", err)
	}
	names := []string{}
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	slices.Sort(names)
	return AccountHomesReply{Folder: folder, Names: names}, nil
}

// AccountHomeCreate creates the home of the account id with mode 0700 and the folders above it.
func AccountHomeCreate(configDir, plugin, id string) error {
	home, err := accountHomeOf(configDir, plugin, id)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return fmt.Errorf("account home %s: %w", id, err)
	}
	// MkdirAll leaves the mode of a folder that exists, so the home takes 0700 also when it existed.
	if err := os.Chmod(home, 0o700); err != nil {
		return fmt.Errorf("account home %s: %w", id, err)
	}
	return nil
}

// AccountHomeRemove removes the home of the account id with its content; a home that does not exist changes nothing.
func AccountHomeRemove(configDir, plugin, id string) error {
	home, err := accountHomeOf(configDir, plugin, id)
	if err != nil {
		return err
	}
	if err := os.RemoveAll(home); err != nil {
		return fmt.Errorf("account home %s: %w", id, err)
	}
	return nil
}

// AccountRun runs an account program of a plugin in the window of the page (docs/spec/native-surfaces.md#account-runs). It answers
// the exit of the program, and the ProgramEnd of a run that a cancel or the end of the window ended.
func (h *Host) AccountRun(ctx context.Context, reqJSON json.RawMessage) (ProgramRunReply, error) {
	req, err := argument[AccountRunRequest]("request", reqJSON)
	if err != nil {
		return ProgramRunReply{}, err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return ProgramRunReply{}, err
	}
	owner := map[string]any{"plugin": req.Plugin, "run": req.Run, "name": req.Name}
	refuse := func(err error) (ProgramRunReply, error) {
		EmitHost(LevelError, "host.program.refused", map[string]any{"plugin": req.Plugin, "run": req.Run, "name": req.Name, "reason": err.Error()})
		return ProgramRunReply{}, err
	}
	if req.Run == 0 {
		return refuse(fmt.Errorf("program run: run must be a positive integer"))
	}
	if !accountPluginIdentifier.MatchString(req.Plugin) {
		return refuse(fmt.Errorf("account home: plugin %s is not a plugin identifier", req.Plugin))
	}
	declared, err := parseProgramDeclarations(req.Programs)
	if err != nil {
		return refuse(err)
	}
	dataFolder, err := PluginDataFolder(s.sidecars.configDir, req.Plugin)
	if err != nil {
		return refuse(err)
	}
	spec, err := checkAccountRun(declared, req.Plugin, req.Name, req.Args, dataFolder)
	if err != nil {
		return refuse(err)
	}
	// The run belongs to the window and ends with its cancel or the window, not with the call that started it.
	runContext, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	if err := s.programs.beginAccount(req.Plugin, req.Run, cancel); err != nil {
		return refuse(err)
	}
	defer s.programs.finish(programRunKey{surface: req.Plugin, id: req.Run, account: true})
	return s.executeProgramRun(runContext, owner, req.Plugin, req.Name, spec)
}

// AccountRunCancel ends the open account run of a plugin. A run that is not open is left alone, so a repeated cancel changes nothing.
func (h *Host) AccountRunCancel(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[AccountRunCancelRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	s.programs.cancelAccount(req.Plugin, req.Run)
	return nil
}

// AccountHomes answers the folder accounts/ of the data folder of a plugin and the names of its folders.
func (h *Host) AccountHomes(ctx context.Context, reqJSON json.RawMessage) (AccountHomesReply, error) {
	req, err := argument[AccountHomesRequest]("request", reqJSON)
	if err != nil {
		return AccountHomesReply{}, err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return AccountHomesReply{}, err
	}
	return AccountHomes(s.sidecars.configDir, req.Plugin)
}

// AccountHomeCreate creates the home of an account of a plugin.
func (h *Host) AccountHomeCreate(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[AccountHomeRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return AccountHomeCreate(s.sidecars.configDir, req.Plugin, req.ID)
}

// AccountHomeRemove removes the home of an account of a plugin with its content.
func (h *Host) AccountHomeRemove(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[AccountHomeRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	return AccountHomeRemove(s.sidecars.configDir, req.Plugin, req.ID)
}
