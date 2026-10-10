package sok

// Runs a declared command (docs/spec/cli.md). The parameter flags are interpreted with the parameter schema that
// exposure.list of the chosen window reports; a flag or value that does not match the schema is rejected before the
// command is sent.

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
)

// commonValues are the common options that take a value and are used together with a declared command.
var commonValues = map[string]bool{"config-dir": true, "window": true, "project": true, "surface": true, "params": true}

// commandWord returns the first positional argument. The value of a common option is not a positional argument.
func commandWord(args []string) string {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "--") {
			return arg
		}
		name, _, inline := strings.Cut(arg[2:], "=")
		if !inline && commonValues[name] {
			i++
		}
	}
	return ""
}

// commandArguments are the arguments of a declared command. flags are the parameter flags before they are interpreted
// with the schema.
type commandArguments struct {
	name   string
	common map[string]string
	flags  []string
}

func parseCommand(args []string) (commandArguments, error) {
	parsed := commandArguments{common: map[string]string{}}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "--") {
			if parsed.name != "" {
				return parsed, usage("unexpected argument %s", arg)
			}
			parsed.name = arg
			continue
		}
		name, value, inline := strings.Cut(arg[2:], "=")
		if !commonValues[name] {
			parsed.flags = append(parsed.flags, arg)
			// When a flag has no value after =, the next argument can be its value. Whether the flag is a boolean is decided
			// after the schema is read.
			if !inline && i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
				i++
				parsed.flags = append(parsed.flags, args[i])
			}
			continue
		}
		if _, seen := parsed.common[name]; seen {
			return parsed, usage("--%s is given twice", name)
		}
		if !inline {
			if i+1 >= len(args) {
				return parsed, usage("--%s needs a value", name)
			}
			i++
			value = args[i]
		}
		parsed.common[name] = value
	}
	return parsed, nil
}

// schema is the declaration of one parameter.
type schema struct {
	Type json.RawMessage `json:"type"`
	Enum []any           `json:"enum"`
}

func (s schema) types() ([]string, error) {
	if len(s.Type) == 0 {
		return nil, nil
	}
	var one string
	if err := json.Unmarshal(s.Type, &one); err == nil {
		return []string{one}, nil
	}
	var many []string
	if err := json.Unmarshal(s.Type, &many); err != nil {
		return nil, fmt.Errorf("parameter type %s is neither a name nor a list of names", s.Type)
	}
	return many, nil
}

// convert turns the text of a flag into a value of the parameter schema.
func convert(name, text string, declared schema) (any, error) {
	if len(declared.Enum) > 0 {
		for _, option := range declared.Enum {
			if fmt.Sprint(option) == text {
				return option, nil
			}
		}
		options := make([]string, 0, len(declared.Enum))
		for _, option := range declared.Enum {
			options = append(options, fmt.Sprint(option))
		}
		return nil, usage("--%s must be one of %s", name, strings.Join(options, ", "))
	}
	types, err := declared.types()
	if err != nil {
		return nil, err
	}
	// When the type list holds null, the text null is null before any other type (docs/spec/cli.md).
	for _, kind := range types {
		if kind == "null" && text == "null" {
			return nil, nil
		}
	}
	failures := []string{}
	for _, kind := range types {
		switch kind {
		case "null":
		case "string":
			return text, nil
		case "number":
			value, err := strconv.ParseFloat(text, 64)
			if err == nil && !math.IsInf(value, 0) && !math.IsNaN(value) {
				return value, nil
			}
		case "integer":
			if value, err := strconv.ParseInt(text, 10, 64); err == nil {
				return value, nil
			}
		case "boolean":
			if text == "true" || text == "false" {
				return text == "true", nil
			}
		case "object", "array":
			var value any
			if err := json.Unmarshal([]byte(text), &value); err == nil {
				_, isObject := value.(map[string]any)
				_, isArray := value.([]any)
				if (kind == "object" && isObject) || (kind == "array" && isArray) {
					return value, nil
				}
			}
		default:
			return nil, fmt.Errorf("parameter --%s has the unknown type %s", name, kind)
		}
		failures = append(failures, kind)
	}
	return nil, usage("--%s must be %s", name, strings.Join(failures, " or "))
}

// declaredCommand is one command of exposure.list.
type declaredCommand struct {
	Name   string `json:"name"`
	Params struct {
		Properties map[string]schema `json:"properties"`
	} `json:"params"`
}

// parameters is the parameter object that interprets the parameter flags with the schema.
func parameters(command declaredCommand, flags []string) (map[string]any, error) {
	params := map[string]any{}
	names := make([]string, 0, len(command.Params.Properties))
	for name := range command.Params.Properties {
		names = append(names, name)
	}
	sort.Strings(names)
	for i := 0; i < len(flags); i++ {
		arg := flags[i]
		if !strings.HasPrefix(arg, "--") {
			return nil, usage("unexpected argument %s", arg)
		}
		name, text, inline := strings.Cut(arg[2:], "=")
		declared, ok := command.Params.Properties[name]
		if !ok {
			return nil, usage("--%s is not a parameter of %s; its parameters are %s", name, command.Name, strings.Join(names, ", "))
		}
		if _, seen := params[name]; seen {
			return nil, usage("--%s is given twice", name)
		}
		types, err := declared.types()
		if err != nil {
			return nil, err
		}
		if !inline {
			if len(types) == 1 && types[0] == "boolean" {
				params[name] = true
				continue
			}
			if i+1 >= len(flags) || strings.HasPrefix(flags[i+1], "--") {
				return nil, usage("--%s needs a value", name)
			}
			i++
			text = flags[i]
		}
		value, err := convert(name, text, declared)
		if err != nil {
			return nil, err
		}
		params[name] = value
	}
	return params, nil
}

// runCommand runs one declared command and prints its result.
func runCommand(args []string, stdout io.Writer, options Options) error {
	parsed, err := parseCommand(args)
	if err != nil {
		return err
	}
	client, err := connectTo(parsed.common, options)
	if err != nil {
		return err
	}
	defer client.Close()
	window, err := selectWindow(arguments{values: parsed.common}, client)
	if err != nil {
		return err
	}
	listed, err := client.Request("exposure.list", map[string]any{"window": window})
	if err != nil {
		return err
	}
	var exposures struct {
		Commands []declaredCommand `json:"commands"`
	}
	if err := json.Unmarshal(listed, &exposures); err != nil {
		return fmt.Errorf("exposure.list returned an unexpected value: %w", err)
	}
	var command *declaredCommand
	for i := range exposures.Commands {
		if exposures.Commands[i].Name == parsed.name {
			command = &exposures.Commands[i]
		}
	}
	if command == nil {
		return usage("%s is not a declared command of window %s; sok commands lists them", parsed.name, window)
	}
	var params any
	if text, ok := parsed.common["params"]; ok {
		if len(parsed.flags) > 0 {
			return usage("--params gives the whole parameter object and cannot be combined with parameter flags")
		}
		var object map[string]any
		if err := json.Unmarshal([]byte(text), &object); err != nil || object == nil {
			return usage("--params must be a JSON object")
		}
		params = object
	} else {
		if params, err = parameters(*command, parsed.flags); err != nil {
			return err
		}
	}
	request := map[string]any{"window": window, "name": parsed.name, "params": params}
	if surface, ok := parsed.common["surface"]; ok {
		request["surface"] = surface
	}
	result, err := client.Request("command.run", request)
	if err != nil {
		return err
	}
	out, err := indent(result)
	if err != nil {
		return err
	}
	_, err = stdout.Write(out)
	return err
}
