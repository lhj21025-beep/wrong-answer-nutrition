# 영양교사 AI 학습 기능 배포 및 테스트

기존 index.html, 사용자 데이터(users/{uid}/data/*)를 유지한 채 study.html을 추가했습니다.

## 기능
- 기존 Firebase 이메일 계정으로 로그인
- Firebase Storage에 PDF/JPG/PNG/WEBP 원본 보관(파일당 최대 10MB)
- Firestore에 파일 정보, 추출 텍스트, AI 질문/답안 기록과 오답을 보관
- 다중파일 선택, 카드/주관식 선택, 개수 5/10(기본)/15/20/30
- 음성 녹음 → Gemini 전사 → 텍스트 확인·수정 → 주관식 AI 채점
- 정답/부분정답/오답 및 원문 인용 근거
- 오답만 재시험, 기존 오답노트(data/notes)로 오답 동기화 시도

## Firebase 배포 전 필수 작업

1. Firebase 프로젝트 ID wrong-answer-nutrition 확인.
2. Firebase Storage 사용 상태 확인.
3. 기존 Gemini API 비밀키가 Secret Manager에 GEMINI_API_KEY라는 이름으로 보관되어 있으면 재사용. 이름이 다른 경우 Functions의 defineSecret 이름을 맞추거나 새 GEMINI_API_KEY 비밀키 등록. GitHub에 키를 게시하지 말 것.
4. 기존 Firebase 규칙은 절대 덮어쓰지 말고 아래 match 블록만 해당 중괄호 안에 추가.

### Firestore 규칙
아래 세 블록은 기존 match /databases/{database}/documents 내부에 삽입합니다.

    match /users/{userId}/studySources/{sourceId} {
      allow read, create, update: if request.auth != null && request.auth.uid == userId;
      allow delete: if false;
      match /parts/{partId} { allow read, write: if false; }
    }
    match /users/{userId}/studyWrong/{wrongId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow write: if false;
    }
    match /users/{userId}/studyAttempts/{attemptId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow write: if false;
    }

### Storage 규칙
아래 블록은 기존 match /b/{bucket}/o 내부에 삽입합니다.

    match /users/{userId}/studySources/{sourceId}/original {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow create: if request.auth != null && request.auth.uid == userId
        && request.resource.size <= 10 * 1024 * 1024
        && (request.resource.contentType == 'application/pdf'
          || request.resource.contentType == 'image/jpeg'
          || request.resource.contentType == 'image/png'
          || request.resource.contentType == 'image/webp');
      allow update, delete: if false;
    }

기존에 상위 포괄 허용 규칙이 있다면 의도하지 않은 접근이 가능하므로 전체 규칙을 검토해야 합니다.

### 새 Functions 코드베이스 배포 명령

    npm --prefix functions install
    firebase login
    firebase use wrong-answer-nutrition
    firebase functions:secrets:get GEMINI_API_KEY
    # 없을 때만: firebase functions:secrets:set GEMINI_API_KEY
    firebase deploy --only functions:study

functions:study는 별도 Firebase Functions 코드베이스로, 기존 analyzeProblemImage를 보존하도록 분리했습니다.

## 확인 방법

기존: https://lhj21025-beep.github.io/wrong-answer-nutrition/
AI 학습: https://lhj21025-beep.github.io/wrong-answer-nutrition/study.html

1. Firebase 로그인 → 이미지/PDF 두 개 업로드.
2. 두 파일 동시 선택 → 카드 10개 생성 → 뒤집기 → 모르겠음.
3. 오답 목록 및 기존 오답노트 동기화 확인.
4. 주관식 → 녹음 시작/종료 → 텍스트 확인/수정 → AI 피드백.
5. 오답 재시험 → 정답 처리 → 복습 완료 확인.
6. 같은 계정으로 다른 기기에서 자료 확인.
7. 다른 계정으로는 해당 파일에 접근할 수 없는지 보안 테스트.

## 한계 및 미완료
- 긴 PDF는 Gemini 출력 제한 때문에 OCR 일부가 누락될 수 있습니다.
- 여러 파일 선택 시 입력 제한 때문에 각 파일의 일부 구간만 사용하는 경우가 있습니다.
- AI 원문 인용을 대조하지만 채점 완전무결성을 보장하지 않습니다.
- 원본 PDF/이미지는 보관합니다. 녹음 원본은 보관하지 않고 전사 텍스트와 채점 기록만 보관합니다.
- 웹앱 코드는 저장했으나 Firebase 함수 배포·보안 규칙 적용·실계정 로그인 테스트는 별도로 필요합니다.
- 갤럭시 브라우저에서 실행되는 웹앱이며 네이티브 Android APK는 아직 빌드하지 않았습니다.
