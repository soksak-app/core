package host

// 애플리케이션 인자(docs/spec/hosts.md#application-arguments). 두 host 는 같은 규칙과 문장으로 인자를 읽는다.

import (
	"fmt"
	"strings"
)

// declaredArguments 는 애플리케이션이 선언한 flag 와 그 값을 담을 Options 의 자리다. 진단 build 는 init 에서 진단
// flag 를 더한다.
var declaredArguments = map[string]func(*Options) *string{
	"config-dir": func(options *Options) *string { return &options.ConfigDir },
}

// argumentEffects 는 창을 열기 전에 인자를 적용하는 일이다. 진단 build 는 init 에서 더한다.
var argumentEffects []func(Options) error

// ApplyArguments 는 읽은 인자를 창을 열기 전에 적용한다.
func ApplyArguments(options Options) error {
	for _, effect := range argumentEffects {
		if err := effect(options); err != nil {
			return err
		}
	}
	return nil
}

// ParseArguments 는 애플리케이션 인자를 읽는다. 선언하지 않은 인자, 값 없는 flag, 두 번 준 flag 는 오류다.
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
