package host

// 애플리케이션 인자(docs/spec/hosts.md#application-arguments). 두 host 는 같은 규칙과 문장으로 인자를 읽는다.

import (
	"fmt"
	"strings"
)

// ParseArguments 는 애플리케이션 인자를 읽는다. 선언하지 않은 인자, 값 없는 flag, 두 번 준 flag 는 오류다.
func ParseArguments(args []string) (Options, error) {
	var options Options
	values := map[string]*string{"config-dir": &options.ConfigDir}
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
