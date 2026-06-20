variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "db_instance_class" {
  type    = string
  default = "db.serverless" # Aurora Serverless v2
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "desired_count" {
  description = "Default task count per service before autoscaling."
  type        = number
  default     = 2
}

variable "image_tag" {
  type    = string
  default = "latest"
}

# --- Autoscaling bounds (per stateless service) ---
variable "autoscale_min" {
  description = "Minimum task count per autoscaled service."
  type        = number
  default     = 2
}

variable "autoscale_max" {
  description = "Maximum task count per autoscaled service."
  type        = number
  default     = 20
}

variable "cpu_target_pct" {
  description = "Target average CPU utilization (%) for target-tracking scaling."
  type        = number
  default     = 60
}

variable "gateway_conns_per_task" {
  description = "Target active WebSocket connections per gateway task."
  type        = number
  default     = 2000
}
