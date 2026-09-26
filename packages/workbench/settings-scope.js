// 기본값, 공통값, 프로젝트 덮어쓰기 순서로 설정을 적용한다.

export function effectiveSettings(defaults, common, project) {
  const values = { ...defaults, ...common, ...project };
  // 기본값: projectOpening 은 공통 값만 있으며 저장하지 않았으면 기본값이다.
  values.projectOpening = common.projectOpening ?? defaults.projectOpening;
  return values;
}
