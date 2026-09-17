# 브랜치 운영

개발은 `dev` 또는 별도 작업 브랜치에서 진행하고, `main` 반영은 PR을 통해 진행합니다. 기본 브랜치는 `main`으로 유지합니다. 커밋·푸시·PR에는 프로젝트의 사용자 승인 경계를 그대로 적용합니다.

## 현재 적용 상태

- 이 작업 폴더에는 `.githooks/pre-push`를 활성화했습니다. 원격 목적지가 `refs/heads/main`이면 푸시를 거절합니다. `dev:main`, 강제 푸시, 삭제도 포함합니다.
- 로컬 설정은 `core.hooksPath=.githooks`, `push.default=simple`입니다. 전역 Git 설정은 변경하지 않습니다.
- **GitHub 서버 보호는 아직 적용되지 않았습니다.** 2026-09-17 현재 비공개 저장소의 보호 API가 요금제 제한으로 HTTP 403을 반환합니다.
- 로컬 훅은 다른 복제본, GitHub 웹/API, 훅을 건너뛰는 명령을 차단하지 못합니다. 서버 보호를 대체하는 보안 경계로 취급하면 안 됩니다.

새로 복제한 작업 폴더에서는 기존 훅 설정이 있는지 먼저 확인합니다. 별도 훅이 있다면 덮어쓰지 않고 통합합니다. 별도 설정이 없다면 아래와 같이 활성화합니다.

```sh
git config --show-origin --get core.hooksPath
git config --local core.hooksPath .githooks
git config --local push.default simple
git switch dev
```

## 서버 보호 설정안

설정 파일: [main-protection.json](../../.github/main-protection.json)

- `main` 변경에는 PR을 요구합니다.
- GitHub Actions의 `verify` 성공과 최신 기준 브랜치 반영을 요구합니다.
- 관리자에게도 적용하고, 강제 푸시와 브랜치 삭제를 막습니다.
- 미해결 PR 대화가 있으면 병합하지 못합니다.
- 현재 1인 개발이므로 외부 리뷰 승인 수는 0입니다. PR과 CI는 필수로 두되, 본인이 승인할 수 없는 리뷰 때문에 병합이 막히는 구성은 피합니다.

비공개를 유지하려면 GitHub Pro가 필요합니다. 무료 계정에서는 공개 저장소에 보호 기능을 사용할 수 있습니다. 요금제 변경과 저장소 공개 전환은 사용자가 결정합니다. [GitHub의 지원 범위](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)

지원 조건이 충족되면 저장해 둔 설정을 적용하고 API로 다시 조회해 적용 여부를 확인합니다.

```sh
gh api --method PUT repos/masondev1024/ieojim/branches/main/protection \
  --input .github/main-protection.json
gh api repos/masondev1024/ieojim/branches/main/protection
```
