package host

// The application arguments (docs/spec/hosts.md#application-arguments). Both hosts read the arguments with the same rules and sentences.

import (
	"fmt"
	"strings"
)

// declaredArguments holds the flags that the application declares and the Options fields that receive their values. A diagnostic build adds the diagnostic
// flags in init.
var declaredArguments = map[string]func(*Options) *string{
	"config-dir": func(options *Options) *string { return &options.ConfigDir },
}

// argumentEffects is the work that applies the arguments before a window opens. A diagnostic build adds to it in init.
var argumentEffects []func(Options) error

// ApplyArguments applies the parsed arguments before a window opens.
func ApplyArguments(options Options) error {
	for _, effect := range argumentEffects {
		if err := effect(options); err != nil {
			return err
		}
	}
	return nil
}

// ParseArguments parses the application arguments. An undeclared argument, a flag without a value, and a flag given twice are errors.
func ParseArguments(args []string) (Options, error) {
	var options Options
	values := map[string]*string{}
	for name, place := range declaredArguments {
		values[name] = place(&options)
	}
	given := map[string]bool{}
	for index := 0; index < len(args); index++ {
		name, value, inline := strings.Cut(strings.TrimPrefix(args[index], "--"), "=")
		target, declared := values[name]
		if !strings.HasPrefix(args[index], "--") || !declared {
			return Options{}, fmt.Errorf("unknown argument %s", args[index])
		}
		if !inline {
			if index+1 == len(args) {
				return Options{}, fmt.Errorf("--%s needs a value", name)
			}
			index++
			value = args[index]
		}
		if value == "" {
			return Options{}, fmt.Errorf("--%s needs a value", name)
		}
		if given[name] {
			return Options{}, fmt.Errorf("--%s is given twice", name)
		}
		given[name] = true
		*target = value
	}
	return options, nil
}
