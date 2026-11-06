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
