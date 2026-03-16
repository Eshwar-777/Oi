terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }

  backend "gcs" {
    # Configure in terraform.tfvars or via -backend-config
    # bucket = "oi-terraform-state"
    # prefix = "terraform/state"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# ---------------------------------------------------------------------------
# APIs
# ---------------------------------------------------------------------------

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "firestore.googleapis.com",
    "pubsub.googleapis.com",
    "cloudscheduler.googleapis.com",
    "storage.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "firebase.googleapis.com",
    "texttospeech.googleapis.com",
    "speech.googleapis.com",
    "aiplatform.googleapis.com",
    "cloudbuild.googleapis.com",
  ])

  service            = each.key
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Artifact Registry (Docker images)
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "oi" {
  location      = var.region
  repository_id = "oi-${var.environment}"
  format        = "DOCKER"

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# Firestore
# ---------------------------------------------------------------------------

resource "google_firestore_database" "default" {
  provider    = google-beta
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# Cloud Storage (uploads, screenshots)
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "uploads" {
  name          = "oi-uploads-${var.project_id}-${var.environment}"
  location      = var.region
  force_destroy = var.environment == "staging"

  lifecycle_rule {
    action { type = "Delete" }
    condition { age = 90 }
  }

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# Pub/Sub (task events)
# ---------------------------------------------------------------------------

resource "google_pubsub_topic" "tasks" {
  name = "oi-tasks-${var.environment}"

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_subscription" "tasks" {
  name  = "oi-tasks-sub-${var.environment}"
  topic = google_pubsub_topic.tasks.id

  ack_deadline_seconds = 60

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

# ---------------------------------------------------------------------------
# Cloud Scheduler (scheduled task triggers)
# ---------------------------------------------------------------------------

resource "google_cloud_scheduler_job" "task_check" {
  name             = "oi-task-check-${var.environment}"
  schedule         = "*/5 * * * *"
  time_zone        = "UTC"
  attempt_deadline = "120s"

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.backend.uri}/internal/check-scheduled-tasks"
    headers = {
      "Content-Type" = "application/json"
    }
    oidc_token {
      service_account_email = google_service_account.backend.email
    }
  }

  depends_on = [google_project_service.apis, google_cloud_run_v2_service.backend]
}

# ---------------------------------------------------------------------------
# Service Account
# ---------------------------------------------------------------------------

resource "google_service_account" "backend" {
  account_id   = "oi-backend-${var.environment}"
  display_name = "OI Backend (${var.environment})"
}

resource "google_service_account" "remote_browser_worker" {
  account_id   = "oi-remote-browser-${var.environment}"
  display_name = "OI Remote Browser Worker (${var.environment})"
}

resource "google_project_iam_member" "backend_roles" {
  for_each = toset([
    "roles/datastore.user",
    "roles/pubsub.editor",
    "roles/storage.objectAdmin",
    "roles/secretmanager.secretAccessor",
    "roles/aiplatform.user",
    "roles/firebase.admin",
    "roles/logging.logWriter",
    "roles/run.admin",
  ])

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_project_iam_member" "remote_browser_worker_roles" {
  for_each = toset([
    "roles/logging.logWriter",
  ])

  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.remote_browser_worker.email}"
}

resource "google_service_account_iam_member" "backend_can_use_remote_browser_worker" {
  service_account_id = google_service_account.remote_browser_worker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.backend.email}"
}

# ---------------------------------------------------------------------------
# Secret Manager
# ---------------------------------------------------------------------------

resource "google_secret_manager_secret" "firebase_config" {
  secret_id = "oi-firebase-config-${var.environment}"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# Cloud Run (backend)
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "backend" {
  name     = "oi-backend-${var.environment}"
  location = var.region

  template {
    service_account = google_service_account.backend.email

    containers {
      image = var.backend_image != "" ? var.backend_image : "gcr.io/cloudrun/hello"

      ports {
        container_port = 8080
      }

      env {
        name  = "ENV"
        value = var.environment
      }
      env {
        name  = "APP_PORT"
        value = "8080"
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "GOOGLE_CLOUD_LOCATION"
        value = var.region
      }
      env {
        name  = "GOOGLE_GENAI_USE_VERTEXAI"
        value = "true"
      }
      env {
        name  = "PUBSUB_TOPIC_TASKS"
        value = google_pubsub_topic.tasks.name
      }
      env {
        name  = "PUBSUB_SUBSCRIPTION_TASKS"
        value = google_pubsub_subscription.tasks.name
      }
      env {
        name  = "GCS_BUCKET_UPLOADS"
        value = google_storage_bucket.uploads.name
      }
      env {
        name  = "ALLOWED_ORIGINS"
        value = var.allowed_origins
      }
      env {
        name  = "LOG_FORMAT"
        value = "json"
      }

      dynamic "env" {
        for_each = var.backend_secret_env_vars
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      dynamic "env" {
        for_each = var.backend_env_vars
        content {
          name  = env.key
          value = env.value
        }
      }

      resources {
        limits = {
          cpu    = var.backend_cpu
          memory = var.backend_memory
        }
      }
    }

    scaling {
      min_instance_count = var.environment == "prod" ? max(var.backend_min_instance_count, 1) : var.backend_min_instance_count
      max_instance_count = var.environment == "prod" ? max(var.backend_max_instance_count, 10) : var.backend_max_instance_count
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.allow_unauthenticated ? 1 : 0
  name     = google_cloud_run_v2_service.backend.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "backend_url" {
  value = google_cloud_run_v2_service.backend.uri
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.oi.repository_id}"
}

output "uploads_bucket" {
  value = google_storage_bucket.uploads.name
}

output "remote_browser_worker_service_account" {
  value = google_service_account.remote_browser_worker.email
}
