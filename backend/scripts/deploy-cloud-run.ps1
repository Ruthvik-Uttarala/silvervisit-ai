param(
  [string]$Service = "silvervisit-backend",
  [Parameter(Mandatory = $true)][string]$Project,
  [string]$Region = "us-central1",
  [string]$Location = "us-central1",
  [string]$ArtifactRepo = "silvervisit-images",
  [int]$TimeoutSeconds = 900,
  [string]$Image = "",
  [string]$AccessTokenFile = "",
  [string[]]$EnvVar = @()
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Split-Path -Parent $ScriptDir
$ContractFile = Join-Path $BackendDir "deploy/cloud-run.contract.json"

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Get-GcloudExe {
  $cmd = Get-Command gcloud.cmd -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallback = Get-Command gcloud -ErrorAction SilentlyContinue
  if ($fallback) { return $fallback.Source }
  throw "gcloud is not installed or not available in PATH."
}

function Invoke-Gcloud {
  param([string[]]$CommandArgs)
  $gcloudExe = Get-GcloudExe
  $fullArgs = @()
  if ($AccessTokenFile) {
    $fullArgs += "--access-token-file=$AccessTokenFile"
  }
  $fullArgs += $CommandArgs
  $prevErrorAction = $ErrorActionPreference
  $script:ErrorActionPreference = "Continue"
  $output = & $gcloudExe @fullArgs 2>&1
  $script:ErrorActionPreference = $prevErrorAction
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud command failed: $($fullArgs -join ' ')`n$output"
  }
  return ($output -join "`n")
}

function Assert-GcloudAuthenticated {
  $active = Invoke-Gcloud -CommandArgs @("auth", "list", "--filter=status:ACTIVE", "--format=value(account)")
  if (-not $active.Trim()) {
    throw "No active gcloud account found. Run: gcloud auth login"
  }
}

function Ensure-ArtifactRepository {
  param([string]$Repository, [string]$ProjectId, [string]$RegionId)
  $describeOk = $true
  try {
    $null = Invoke-Gcloud -CommandArgs @("artifacts", "repositories", "describe", $Repository, "--project", $ProjectId, "--location", $RegionId, "--format=value(name)")
  } catch {
    $describeOk = $false
  }
  if ($describeOk) {
    return
  }

  Write-Output "Artifact Registry repository '$Repository' not found in $RegionId. Creating..."
  Invoke-Gcloud -CommandArgs @(
    "artifacts", "repositories", "create", $Repository,
    "--project", $ProjectId,
    "--location", $RegionId,
    "--repository-format", "docker",
    "--description", "SilverVisit backend deployment images"
  ) | Out-Null
}

if (-not (Test-Path $ContractFile)) {
  throw "Missing deployment contract: $ContractFile"
}

Require-Command npm
$null = Get-GcloudExe

if ($TimeoutSeconds -lt 1) {
  throw "TimeoutSeconds must be >= 1."
}

if ($AccessTokenFile) {
  if (-not (Test-Path $AccessTokenFile)) {
    throw "Provided access token file does not exist: $AccessTokenFile"
  }
} else {
  Assert-GcloudAuthenticated
}

if (-not $Image) {
  Ensure-ArtifactRepository -Repository $ArtifactRepo -ProjectId $Project -RegionId $Region
  $Image = "$Region-docker.pkg.dev/$Project/$ArtifactRepo/$Service`:latest"
}

if ($EnvVar.Count -eq 0) {
  $EnvVar = @(
    "GOOGLE_GENAI_USE_VERTEXAI=true",
    "GOOGLE_CLOUD_PROJECT=$Project",
    "GOOGLE_CLOUD_LOCATION=$Location",
    "GEMINI_ACTION_MODEL=gemini-2.5-flash",
    "GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio",
    "ENABLE_LIVE_API=true",
    "ENABLE_FIRESTORE=true",
    "FIRESTORE_COLLECTION_PREFIX=silvervisit",
    "HTTP_REQUEST_TIMEOUT_MS=0",
    "HTTP_HEADERS_TIMEOUT_MS=70000",
    "HTTP_KEEPALIVE_TIMEOUT_MS=65000"
  )
}

$envJoined = ($EnvVar -join ",")
$requiredApis = @(
  "run.googleapis.com",
  "cloudbuild.googleapis.com",
  "artifactregistry.googleapis.com",
  "aiplatform.googleapis.com",
  "firestore.googleapis.com"
)

Write-Output "Running secret hygiene check..."
Push-Location $BackendDir
try {
  npm run secret:hygiene
  if ($LASTEXITCODE -ne 0) {
    throw "Secret hygiene check failed."
  }
} finally {
  Pop-Location
}

Write-Output "Checking required Google APIs..."
foreach ($api in $requiredApis) {
  $enabled = Invoke-Gcloud -CommandArgs @("services", "list", "--enabled", "--project", $Project, "--filter", "name:$api", "--format=value(name)")
  if (-not $enabled.Trim()) {
    throw "Required API is not enabled: $api. Enable with: gcloud services enable $api --project $Project"
  }
}

$previousRevision = ""
try {
  $previousRevision = (Invoke-Gcloud -CommandArgs @("run", "services", "describe", $Service, "--project", $Project, "--region", $Region, "--platform", "managed", "--format=value(status.latestReadyRevisionName)")).Trim()
} catch {
  $previousRevision = ""
}

Write-Output "Building image with Cloud Build: $Image"
Invoke-Gcloud -CommandArgs @("builds", "submit", $BackendDir, "--project", $Project, "--tag", $Image) | Out-Null

Write-Output "Deploying to Cloud Run: service=$Service, region=$Region, timeout=$TimeoutSeconds"
Invoke-Gcloud -CommandArgs @(
  "run", "deploy", $Service,
  "--project", $Project,
  "--region", $Region,
  "--platform", "managed",
  "--allow-unauthenticated",
  "--image", $Image,
  "--port", "8080",
  "--timeout", "$TimeoutSeconds",
  "--set-env-vars", $envJoined
) | Out-Null

$serviceUrl = (Invoke-Gcloud -CommandArgs @("run", "services", "describe", $Service, "--project", $Project, "--region", $Region, "--platform", "managed", "--format=value(status.url)")).Trim()
$latestRevision = (Invoke-Gcloud -CommandArgs @("run", "services", "describe", $Service, "--project", $Project, "--region", $Region, "--platform", "managed", "--format=value(status.latestReadyRevisionName)")).Trim()

Write-Output "Deployed service URL: $serviceUrl"
Write-Output "Latest ready revision: $latestRevision"
if ($previousRevision) {
  Write-Output "Rollback command:"
  Write-Output "  gcloud run services update-traffic $Service --project $Project --region $Region --platform managed --to-revisions $previousRevision=100"
}

Write-Output "Running post-deploy verifier..."
Push-Location $BackendDir
try {
  $verifyArgs = @("--base-url", $serviceUrl, "--service", $Service, "--region", $Region, "--project", $Project)
  if ($AccessTokenFile) {
    $verifyArgs += @("--access-token-file", $AccessTokenFile)
  }
  npm run verify:cloud-run -- $verifyArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Post-deploy verification failed."
  }
} finally {
  Pop-Location
}

Write-Output "Deployment and verification completed successfully."
