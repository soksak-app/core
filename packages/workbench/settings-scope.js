// 기본값, 공통값, 프로젝트 덮어쓰기 순서로 설정을 적용한다.

export function effectiveSettings(defaults, common, project) {
  const values = { ...defaults, ...common, ...project };
  values.projectOpening = common.projectOpening ?? defaults.projectOpening;
  return values;
}
