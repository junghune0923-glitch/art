# art

새 웹페이지 작업을 시작하기 위한 기본 HTML 저장소입니다.

## 배포 설정

Disqus 댓글을 사용하려면 Cloudflare Worker 환경변수 `DISQUS_SHORTNAME`에 Disqus 사이트 shortname을 넣어 배포합니다.

로컬에서 임시로 확인할 때는 `index.html` 로드 전에 `window.VILLAIN_DISQUS_SHORTNAME = "your-shortname"`을 설정하면 같은 코드가 사용됩니다.

Cloudflare Worker, Durable Object, Disqus 설정 흐름은 기존 `wrangler.toml`과 `_worker.js`를 그대로 사용합니다.
