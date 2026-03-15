#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONTRACT_FILE="${BACKEND_DIR}/deploy/cloud-run.contract.json"

usage() {
  cat <<EOF
Deploy SilverVisit backend to Cloud Run.

Usage:
  ./scripts/deploy-cloud-run.sh \\
    --service SERVICE_NAME \
    --project PROJECT_ID \
    --region REGION \
    [--location GOOGLE_CLOUD_LOCATION] \
    [--artifact-repo REPOSITORY] \
    [--timeout-seconds 900] \
    [--image IMAGE_URI] \
    [--env KEY=VALUE]...

Examples:
  ./scripts/deploy-cloud-run.sh --service silvervisit-backend --project my-proj --region us-central1
  ./scripts/deploy-cloud-run.sh --service silvervisit-backend --project my-proj --region us-central1 \\
    --location us-central1 --timeout-seconds 900
EOF
}

SERVICE="silvervisit-backend"
PROJECT=""
REGION="us-central1"
LOCATION="us-central1"
ARTIFACT_REPO="silvervisit-images"
TIMEOUT_SECONDS="900"
IMAGE=""
ENV_VARS=()
ACCESS_TOKEN_FILE="${GCLOUD_ACCESS_TOKEN_FILE:-}"

REQUIRED_APIS=(
  "run.googleapis.com"
  "cloudbuild.googleapis.com"
  "artifactregistry.googleapis.com"
  "aiplatform.googleapis.com"
  "firestore.googleapis.com"
)

GCLOUD_ARGS=()

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1"
    exit 1
  fi
}

assert_authenticated() {
  local active
  active="$(gcloud auth list --filter='status:ACTIVE' --format='value(account)' 2>/dev/null || true)"
  if [[ -z "${active}" ]]; then
    echo "No active gcloud account found."
    echo "Run: gcloud auth login"
    exit 1
  fi
}

ensure_artifact_repository() {
  local repo="$1"
  if gcloud_cmd artifacts repositories describe "${repo}" --project "${PROJECT}" --location "${REGION}" --format='value(name)' >/dev/null 2>&1; then
    return
  fi
  echo "Artifact Registry repository '${repo}' not found in ${REGION}. Creating..."
  gcloud_cmd artifacts repositories create "${repo}" \
    --project "${PROJECT}" \
    --location "${REGION}" \
    --repository-format docker \
    --description "SilverVisit backend deployment images"
}

gcloud_cmd() {
  gcloud "${GCLOUD_ARGS[@]}" "$@"
}

assert_enabled_api() {
  local api="$1"
  local found
  found="$(gcloud_cmd services list --enabled --project "${PROJECT}" --filter="name:${api}" --format='value(name)')"
  if [[ -z "${found}" ]]; then
    echo "Required API is not enabled: ${api}"
    echo "Enable with: gcloud services enable ${api} --project ${PROJECT}"
    exit 1
  fi
}

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
    --artifact-repo)
      ARTIFACT_REPO="$2"
      shift 2
      ;;
    --location)
      LOCATION="$2"
      shift 2
      ;;
    --timeout-seconds)
      TIMEOUT_SECONDS="$2"
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

if [[ -z "${PROJECT}" ]]; then
  echo "Missing required arguments."
  usage
  exit 1
fi

if [[ ! -f "${CONTRACT_FILE}" ]]; then
  echo "Missing deployment contract: ${CONTRACT_FILE}"
  exit 1
fi

if [[ ! "${TIMEOUT_SECONDS}" =~ ^[0-9]+$ ]]; then
  echo "timeout-seconds must be an integer."
  exit 1
fi

require_command gcloud
require_command npm

if [[ -n "${ACCESS_TOKEN_FILE}" ]]; then
  if [[ ! -f "${ACCESS_TOKEN_FILE}" ]]; then
    echo "Provided access token file does not exist: ${ACCESS_TOKEN_FILE}"
    exit 1
  fi
  GCLOUD_ARGS=(--access-token-file="${ACCESS_TOKEN_FILE}")
else
  assert_authenticated
fi

if [[ -z "$IMAGE" ]]; then
  ensure_artifact_repository "${ARTIFACT_REPO}"
  IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${ARTIFACT_REPO}/${SERVICE}:latest"
fi

if [[ ${#ENV_VARS[@]} -eq 0 ]]; then
  ENV_VARS=(
    "GOOGLE_GENAI_USE_VERTEXAI=true"
    "GOOGLE_CLOUD_PROJECT=${PROJECT}"
    "GOOGLE_CLOUD_LOCATION=${LOCATION}"
    "GEMINI_ACTION_MODEL=gemini-2.5-flash"
    "GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio"
    "ENABLE_LIVE_API=true"
    "ENABLE_FIRESTORE=true"
    "FIRESTORE_COLLECTION_PREFIX=silvervisit"
  )
fi

ENV_JOINED=$(IFS=, ; echo "${ENV_VARS[*]}")

echo "Running secret hygiene check..."
(cd "${BACKEND_DIR}" && npm run secret:hygiene)

echo "Checking required Google APIs..."
for api in "${REQUIRED_APIS[@]}"; do
  assert_enabled_api "${api}"
done

PREVIOUS_READY_REVISION="$(gcloud_cmd run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --platform managed --format='value(status.latestReadyRevisionName)' 2>/dev/null || true)"

echo "Building image: ${IMAGE}"
gcloud_cmd builds submit "${BACKEND_DIR}" --project "${PROJECT}" --tag "${IMAGE}"

echo "Deploying to Cloud Run: service=${SERVICE}, project=${PROJECT}, region=${REGION}, timeout=${TIMEOUT_SECONDS}s"
gcloud_cmd run deploy "${SERVICE}" \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --image "${IMAGE}" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --timeout "${TIMEOUT_SECONDS}" \
  --set-env-vars "${ENV_JOINED}"

SERVICE_URL="$(gcloud_cmd run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --platform managed --format='value(status.url)')"
LATEST_READY_REVISION="$(gcloud_cmd run services describe "${SERVICE}" --project "${PROJECT}" --region "${REGION}" --platform managed --format='value(status.latestReadyRevisionName)')"

echo "Deployed service URL: ${SERVICE_URL}"
if [[ -n "${PREVIOUS_READY_REVISION}" ]]; then
  echo "Rollback command:"
  echo "  gcloud run services update-traffic ${SERVICE} --project ${PROJECT} --region ${REGION} --platform managed --to-revisions ${PREVIOUS_READY_REVISION}=100"
fi
echo "Latest ready revision: ${LATEST_READY_REVISION}"

echo "Running post-deploy verification..."
if [[ -n "${ACCESS_TOKEN_FILE}" ]]; then
  VERIFY_TOKEN_ARGS=(--access-token-file "${ACCESS_TOKEN_FILE}")
else
  VERIFY_TOKEN_ARGS=()
fi

if ! (cd "${BACKEND_DIR}" && npm run verify:cloud-run -- --base-url "${SERVICE_URL}" --service "${SERVICE}" --region "${REGION}" --project "${PROJECT}" "${VERIFY_TOKEN_ARGS[@]}"); then
  echo "Post-deploy verification failed."
  if [[ -n "${PREVIOUS_READY_REVISION}" ]]; then
    echo "Use rollback command shown above to restore traffic."
  fi
  exit 1
fi

echo "Deployment and verification completed successfully."
