# art

HTML 작업물 저장소입니다.

## 배포 설정

Disqus 댓글을 사용하려면 Cloudflare Worker 환경변수 `DISQUS_SHORTNAME`에 Disqus 사이트 shortname을 넣어 배포합니다.

로컬에서 임시로 확인할 때는 `index.html` 로드 전에 `window.VILLAIN_DISQUS_SHORTNAME = "your-shortname"`을 설정하면 같은 코드가 사용됩니다.
