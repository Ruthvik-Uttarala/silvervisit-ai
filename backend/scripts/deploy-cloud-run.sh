#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Deploy SilverVisit backend to Cloud Run.

Usage:
  ./scripts/deploy-cloud-run.sh \
    --service SERVICE_NAME \
    --project PROJECT_ID \
    --region REGION \
    [--image IMAGE_URI] \
    [--env KEY=VALUE]...

Examples:
  ./scripts/deploy-cloud-run.sh --service silvervisit-backend --project my-proj --region us-central1
  ./scripts/deploy-cloud-run.sh --service silvervisit-backend --project my-proj --region us-central1 \
    --env GOOGLE_GENAI_USE_VERTEXAI=true --env GOOGLE_CLOUD_LOCATION=global --env ENABLE_LIVE_API=true
EOF
}

SERVICE=""
PROJECT=""
REGION=""
IMAGE=""
ENV_VARS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)
      SERVICE="$2"
      shift 2
      ;;
    --project)
      PROJECT="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --image)
      IMAGE="$2"
      shift 2
      ;;
    --env)
      ENV_VARS+=("$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$SERVICE" || -z "$PROJECT" || -z "$REGION" ]]; then
  echo "Missing required arguments."
  usage
  exit 1
fi

if [[ -z "$IMAGE" ]]; then
  IMAGE="gcr.io/${PROJECT}/${SERVICE}:latest"
fi

if [[ ${#ENV_VARS[@]} -eq 0 ]]; then
  ENV_VARS=(
    "GOOGLE_GENAI_USE_VERTEXAI=true"
    "GOOGLE_CLOUD_PROJECT=${PROJECT}"
    "GOOGLE_CLOUD_LOCATION=global"
    "GEMINI_ACTION_MODEL=gemini-2.5-flash"
    "GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio"
    "ENABLE_LIVE_API=true"
    "ENABLE_FIRESTORE=true"
    "FIRESTORE_COLLECTION_PREFIX=silvervisit"
  )
fi

ENV_JOINED=$(IFS=, ; echo "${ENV_VARS[*]}")

echo "Building image: ${IMAGE}"
docker build -t "${IMAGE}" .

echo "Pushing image: ${IMAGE}"
docker push "${IMAGE}"

echo "Deploying to Cloud Run: service=${SERVICE}, project=${PROJECT}, region=${REGION}"
gcloud run deploy "${SERVICE}" \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars "${ENV_JOINED}"

echo "Deployment complete."
