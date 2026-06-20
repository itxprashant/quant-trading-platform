###############################################################################
# Quanta platform — AWS infrastructure skeleton
#
# This is an intentionally high-level skeleton showing the target topology for
# thousands of concurrent users. Fill in security groups, IAM, task definitions,
# secrets (SSM/Secrets Manager), and autoscaling policies before production use.
###############################################################################

locals {
  name = "quanta-${var.environment}"
}

# ---------------------------------------------------------------------------
# Network — VPC with public + private subnets across 3 AZs.
# ---------------------------------------------------------------------------
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = local.name
  cidr = var.vpc_cidr

  azs             = ["${var.region}a", "${var.region}b", "${var.region}c"]
  public_subnets  = ["10.20.0.0/20", "10.20.16.0/20", "10.20.32.0/20"]
  private_subnets = ["10.20.128.0/20", "10.20.144.0/20", "10.20.160.0/20"]

  enable_nat_gateway = true
  single_nat_gateway = var.environment != "prod"
}

# ---------------------------------------------------------------------------
# Data stores — Aurora PostgreSQL (Serverless v2) + ElastiCache Redis.
# ---------------------------------------------------------------------------
# Aurora cluster holds durable state (users, challenges, orders, trades).
# resource "aws_rds_cluster" "pg" { ... engine = "aurora-postgresql" ... }
# resource "aws_rds_cluster_instance" "pg" { instance_class = var.db_instance_class ... }

# ElastiCache Redis: streams (commands/events), pub/sub fan-out, hot state.
# resource "aws_elasticache_replication_group" "redis" {
#   node_type = var.redis_node_type
#   automatic_failover_enabled = true
#   num_node_groups = 1
# }

# ---------------------------------------------------------------------------
# Compute — ECS Fargate cluster + ALB (HTTP + WebSocket).
# Services: api, gateway, engine, scoring, web. Each scales independently.
# Gateway target group uses long idle timeouts + sticky-less token reconnect.
# ---------------------------------------------------------------------------
resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# resource "aws_lb" "main" { load_balancer_type = "application" ... }
# resource "aws_ecs_service" "api"     { desired_count = var.desired_count ... }
# resource "aws_ecs_service" "gateway" { desired_count = var.desired_count ... }  # WS fan-out, scale on connections
# resource "aws_ecs_service" "engine"  { desired_count = 1 ... }                  # leader-elected per challenge
# resource "aws_ecs_service" "scoring" { desired_count = 1 ... }
# resource "aws_ecs_service" "web"     { desired_count = var.desired_count ... }

# ---------------------------------------------------------------------------
# Autoscaling — target-tracking so the platform absorbs thousands of users.
#
# Stateless services (api, web, gateway) scale horizontally:
#   - api / web : average CPU utilization.
#   - gateway   : CPU *and* a custom CloudWatch metric for active WS
#                 connections per task (publish qtp_ws_connections from the
#                 /metrics endpoint via the CloudWatch agent / ADOT collector).
#
# engine + scoring are leader-elected singletons per challenge and are NOT
# horizontally autoscaled here; they scale with the number of live challenges.
# ---------------------------------------------------------------------------
locals {
  scaled_services = ["api", "web", "gateway"]
}

resource "aws_appautoscaling_target" "svc" {
  for_each = toset(local.scaled_services)

  max_capacity       = var.autoscale_max
  min_capacity       = var.autoscale_min
  resource_id        = "service/${aws_ecs_cluster.main.name}/${local.name}-${each.key}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# CPU target-tracking for every stateless service.
resource "aws_appautoscaling_policy" "svc_cpu" {
  for_each = aws_appautoscaling_target.svc

  name               = "${each.value.resource_id}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  service_namespace  = each.value.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = var.cpu_target_pct
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# Connection-aware scaling for the WebSocket gateway: keep active connections
# per task near a target so socket fan-out stays responsive under load.
resource "aws_appautoscaling_policy" "gateway_conns" {
  name               = "${local.name}-gateway-conns"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.svc["gateway"].resource_id
  scalable_dimension = aws_appautoscaling_target.svc["gateway"].scalable_dimension
  service_namespace  = aws_appautoscaling_target.svc["gateway"].service_namespace

  target_tracking_scaling_policy_configuration {
    customized_metric_specification {
      metric_name = "qtp_ws_connections"
      namespace   = "Quanta/${var.environment}"
      statistic   = "Average"
      unit        = "Count"
    }
    target_value       = var.gateway_conns_per_task
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
