# Mutation 검사

[English](mutations.md)

`pnpm check-breaks`는 `scripts/breaks.mjs`에 선언한 각 결함을 검출해야 한다. 결함은 정확히 한 위치에 일치해야 한다. `pnpm mutate`는 operator 치환을 탐색하고 살아남은 mutation을 보고한다. 살아남은 mutation은 필수 검사에서만 실패 결과이다.

두 command는 폐기할 복사본에서 실행하고 원래 package는 바꾸지 않으며, 결함을 적용하기 전에 선택한 test가 통과해야 한다. Node test 승인은 공통 실행 test 근거를 사용한다. 빈 file, skip한 test, todo로는 baseline 통과를 입증할 수 없다. 각 command는 test file을 별도 process group에서 실행하고 deadline이나 취소 때 해당 group을 종료하며, 이후 복사한 package를 제거한다.

매 실행은 표준 출력, 표준 오류, command 결과·경과 시간·test 근거를 담은 JSON 결과를 보존한다. Command는 근거 directory를 출력한다. `SOKSAK_MUTATION_RUN_FOLDER`는 이미 존재하는 상위 directory를 선택하며, 없으면 system 임시 directory를 사용한다. 근거는 폐기할 package 밖에 있어 cleanup 뒤에도 남는다. 최종 summary는 측정한 mutation과 결과를 기록한다.

| 분류 | Mutation에 대한 의미 |
| --- | --- |
| `passed` | 선택한 test가 통과했고 mutation이 살아남았다. |
| `assertion-failure` | Test assertion이 mutation을 검출했다. |
| `runtime-failure` | Mutation이 test process 또는 runtime 실패를 일으켰다. |
| `mutant-timeout` | Mutation이 실행 deadline에 도달했다. |
| `environment-error` | Command를 시작하지 못했거나 필요한 dependency·실행 근거가 없거나 실험이 중단되었다. Mutation 검출이 아니다. |

Baseline은 `passed`만 승인한다. 필수 mutation은 assertion 실패, runtime 실패 또는 mutant timeout을 승인하고, 살아남은 mutation, 일치하지 않거나 여러 곳에 일치하는 edit, 환경 오류에서 실패한다. 탐색 실행은 환경 오류를 점수에 넣지 않고 중단한다. 출력과 JSON record는 deadline을 취소 또는 감독 process 소멸과 구분한다. 감독 원인이 기록되지 않은 종료 signal은 process를 끝낸 주체를 식별할 수 없으므로 환경 오류이다. Source 구문 오류나 throw한 runtime error는 유효한 검출로 유지한다.

## 변경한 소유 module

`node scripts/check-breaks.mjs --changed <base>...<head>`는 `scripts/required-breaks.mjs`에 선언한 필수 결함과 소유 test file을 선택한다. Source 변경은 해당 구현 소유 module을 선택한다. 지정한 소유 test 변경은 그 소유 module들을 선택하며, 공통 test, mutation script, layout 계약, 공통 build 입력 변경은 전체 필수 집합을 선택한다. 무관한 package는 선택하지 않고, 필수 소유 module이 없는 새 구현 source는 오류이다. 이전 tree가 없는 첫 push는 현재 tree에서 선택한다. `--required`는 한정된 전체 필수 집합을 로컬에서 실행하며, filter 없는 command는 전체 선언 결함 inventory를 계속 실행한다.

필수 집합은 결함 최대 8개, 소유 module마다 test file 최대 3개로 제한한다. 선택한 모든 test는 먼저 불변인 package 복사본 하나에서 통과해야 한다. 이후 각 결함은 해당 baseline의 별도 복사본에서 선언한 test만 실행하므로, live checkout 편집이 실험 도중 검증 입력을 바꿀 수 없다. 살아남은 필수 결함, 유효하지 않은 실행 근거, baseline 실패는 gate를 거부한다.

`core-node` CI job은 package build와 test 뒤 push 또는 pull request의 양쪽 revision으로 이 선택을 실행한다. 기존 필수 job gate에 해당 결과가 포함된다. 표준 출력, 표준 오류, 결과 record는 성공적인 검출도 포함하여 `required-mutation-evidence` artifact로 보존한다. 무관한 변경은 mutation artifact를 만들지 않는다. 이 gate는 선택한 선언 결함의 검출을 입증하며, 전체 탐색 mutation 점수나 application 승인을 입증하지 않는다.
