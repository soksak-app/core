package sok

// 선언된 command 를 실행한다(docs/spec/cli.md). 매개변수 flag 는 고른 창의 exposure.list 가 보고하는 매개변수
// schema 로 해석하며, 맞지 않는 flag 와 값은 command 를 보내기 전에 거부한다.

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
)

// commonValues 는 선언된 command 와 함께 쓰는, 값을 받는 공통 option 이다.
var commonValues = map[string]bool{"config-dir": true, "window": true, "project": true, "surface": true, "params": true}

// commandWord 는 첫 위치 인자를 돌려준다. 공통 option 의 값은 위치 인자가 아니다.
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

// commandArguments 는 선언된 command 의 인자다. flags 는 schema 로 해석하기 전의 매개변수 flag 다.
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
			// 값을 = 뒤에 주지 않은 flag 의 다음 인자는 그 값일 수 있다. boolean 인지는 schema 를 읽은 뒤 정한다.
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

// schema 는 매개변수 하나의 선언이다.
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

// convert 는 flag 의 텍스트를 매개변수 schema 의 값으로 바꾼다.
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
	// 목록에 null 이 있으면 텍스트 null 은 다른 type 보다 먼저 null 이다(docs/spec/cli.md).
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

// declaredCommand 는 exposure.list 의 command 하나다.
type declaredCommand struct {
	Name   string `json:"name"`
	Params struct {
		Properties map[string]schema `json:"properties"`
	} `json:"params"`
}

// parameters 는 매개변수 flag 를 schema 로 해석한 매개변수 객체다.
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

// runCommand 는 선언된 command 하나를 실행하고 결과를 출력한다.
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
