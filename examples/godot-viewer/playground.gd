extends Node2D

var elapsed := 0.0

func _process(delta: float) -> void:
	elapsed += delta
	$Robot.position = Vector2(480 + sin(elapsed * 0.8) * 210, 320 - abs(sin(elapsed * 3)) * 35)
	$Robot.flip_h = cos(elapsed * 0.8) < 0
	$Clock.text = "Runtime %.1f s" % elapsed

func _draw() -> void:
	for x in range(0, 961, 40):
		draw_line(Vector2(x, 0), Vector2(x, 540), Color(0.1, 0.16, 0.23), 1)
	for y in range(0, 541, 40):
		draw_line(Vector2(0, y), Vector2(960, y), Color(0.1, 0.16, 0.23), 1)
	draw_rect(Rect2(120, 380, 720, 12), Color(0.25, 0.85, 0.65))
	draw_circle(Vector2(145, 145), 25, Color(0.3, 0.65, 0.95))
	draw_circle(Vector2(820, 170), 16, Color(1, 0.65, 0.3))
