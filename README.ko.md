# soksak

[English](README.md)

soksak 배치 라이브러리, 워크벤치 프런트엔드, 플러그인, 애플리케이션의 작업 공간이다.

| 디렉터리 | 내용 |
| --- | --- |
| [`packages/soksak`](packages/soksak/README.ko.md) | 헤드리스 분할 배치 라이브러리 |
| [`packages/workbench`](docs/spec/plugins.ko.md) | 워크벤치 프런트엔드와 플러그인 로드 |
| [`packages/plugin-api`](docs/spec/plugins.ko.md) | 플러그인과 환경 형식 |
| [`packages/host`](docs/spec/hosts.ko.md) | Wails v3와 Tauri v2 네이티브 호스트 라이브러리 |
| [`apps`](apps/README.ko.md) | 브라우저, Wails, Tauri 애플리케이션 |
| `native/darwin` | macOS 네이티브 공용 라이브러리 |
| `e2e` | 실행 중인 네이티브 애플리케이션의 창 검사 |

플러그인과 사이드카는 자기 repository에 있다([Repository](docs/spec/plugins.ko.md#repository)).

```sh
make prepare
make verify
pnpm test
```

- [배치 규칙과 API](packages/soksak/docs/layout.ko.md)
- [애플리케이션](apps/README.ko.md)
- [플러그인과 애플리케이션 환경](docs/spec/plugins.ko.md)
- [프로젝트·설정·창](docs/spec/projects.ko.md)
- [설정 창](docs/spec/settings.ko.md)
- [네이티브 호스트](docs/spec/hosts.ko.md)
- [네이티브 표면 배치](docs/spec/native-surfaces.ko.md)
- [data-native-modal](docs/spec/native-modals.ko.md)
- [릴리스 설치](docs/operations/install.ko.md)
- [비공개 네이티브 API와 업데이트 검토](docs/operations/private-native-apis.ko.md)
- [구현·검증·배포 상태](docs/features.ko.md)
- [변경 기록](CHANGELOG.ko.md)
- [개발 및 필수 검사](AGENTS.ko.md)

MIT 라이선스: [LICENSE](LICENSE).
