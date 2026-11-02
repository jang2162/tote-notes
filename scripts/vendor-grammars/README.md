# tm-grammars 바깥 문법

`tm-grammars` 에 없는 문법을 원본 그대로 둔다. `pnpm sync:bundled` 가 여기서 `tote.languages` 로 복사한다. 동기화는 네트워크에 나가지 않는다.

| 파일                 | 내용                                             |
| -------------------- | ------------------------------------------------ |
| `<이름>.json`        | 받은 문법 파일 그대로(한 바이트도 고치지 않는다) |
| `<이름>.LICENSE.txt` | 같은 커밋의 라이선스 파일 그대로                 |

출처 URL(커밋 해시가 든 것), 파일의 sha256, 라이선스 SPDX·URL 은 `scripts/bundled-languages.ts` 의 `VENDOR_GRAMMARS` 에 적는다. sync 는 파일의 sha256 이 표와 다르거나 라이선스가 `ALLOWED_LICENSES` 밖이면 멈춘다. 그래서 여기 JSON 은 `.oxfmtrc.json` 의 포맷 대상에서 뺐다.

## 새 커밋으로 올리거나 문법을 더할 때

1. 커밋 해시를 넣은 raw URL 로 문법 파일과 라이선스 파일을 받아 위 이름으로 둔다.
2. `VENDOR_GRAMMARS` 에 `source`·`sha256`(`shasum -a 256 <이름>.json`)·`license` 를 적는다. 라이선스는 원문을 읽고 SPDX 를 정한다.
3. 쓰는 언어의 `grammar`(또는 `EXTRA_GRAMMARS`)에 이름을 넣고 `pnpm sync:bundled` 를 돌린다.

이름은 `tm-grammars` 의 문법 이름과 겹치면 안 된다(번들의 `grammars/<이름>.json` 이 겹친다). `scripts/sync-bundled.test.ts` 가 이것과, 이 폴더에 표에 없는 파일이 없는지를 본다.
