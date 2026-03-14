variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Environment: staging or prod"
  type        = string
  default     = "staging"
  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "Environment must be staging or prod."
  }
}

variable "backend_image" {
  description = "Docker image URI for the backend Cloud Run service"
  type        = string
  default     = ""
}

variable "backend_min_instance_count" {
  description = "Minimum Cloud Run instances for the backend"
  type        = number
  default     = 0
}

variable "backend_max_instance_count" {
  description = "Maximum Cloud Run instances for the backend"
  type        = number
  default     = 3
}

variable "backend_cpu" {
  description = "Cloud Run CPU limit for the backend container"
  type        = string
  default     = "2"
}

variable "backend_memory" {
  description = "Cloud Run memory limit for the backend container"
  type        = string
  default     = "1Gi"
}

variable "allow_unauthenticated" {
  description = "Whether the backend should be publicly invokable"
  type        = bool
  default     = true
}

variable "allowed_origins" {
  description = "CORS allowed origins for the backend"
  type        = string
  default     = "http://localhost:3000,http://localhost:8081"
}

variable "backend_secret_env_vars" {
  description = "Map of environment variable name to Secret Manager secret ID"
  type        = map(string)
  default     = {}
}

variable "backend_env_vars" {
  description = "Additional plain-text environment variables for the backend Cloud Run service"
  type        = map(string)
  default     = {}
}
