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

// defaultsName reports whether name is the name of an argument of the macOS argument domain: a letter or an underscore, then letters,
// digits and underscores.
func defaultsName(name string) bool {
	for index, r := range name {
		letter := r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		if !letter && (index == 0 || r < '0' || r > '9') {
			return false
		}
	}
	return name != ""
}

// ParseArguments parses the application arguments. An undeclared argument, a flag without a value, and a flag given twice are errors.
// A pair `-Name value` whose name is an identifier belongs to the argument domain of macOS, which Foundation reads from the command line
// itself (NSArgumentDomain of NSUserDefaults); it is accepted and passed over, with the same rules for a missing value and a repetition.
func ParseArguments(args []string) (Options, error) {
	var options Options
	values := map[string]*string{}
	for name, place := range declaredArguments {
		values[name] = place(&options)
	}
	given := map[string]bool{}
	for index := 0; index < len(args); index++ {
		if name, ok := strings.CutPrefix(args[index], "-"); ok && !strings.HasPrefix(name, "-") && defaultsName(name) {
			if index+1 == len(args) || args[index+1] == "" {
				return Options{}, fmt.Errorf("-%s needs a value", name)
			}
			if given["-"+name] {
				return Options{}, fmt.Errorf("-%s is given twice", name)
			}
			given["-"+name] = true
			index++
			continue
		}
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
