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
