extends Node
## Add as an Autoload named HarnessViewerBridge before exporting for Web.

var _callback: JavaScriptObject
var _paused := false
var _reloading := false
var _selected_path := ""
var _overlays := {"collision": false, "navmesh": false, "physics": false}

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	if not OS.has_feature("web"):
		return
	var bridge = JavaScriptBridge.get_interface("HarnessGodotBridge")
	if bridge == null:
		return
	_callback = JavaScriptBridge.create_callback(_receive)
	bridge.register(_callback)
	get_tree().node_added.connect(func(_node: Node) -> void: call_deferred("_send_state"))
	get_tree().node_removed.connect(func(_node: Node) -> void: call_deferred("_send_state"))
	call_deferred("_send_state")

func _receive(args: Array) -> void:
	if args.is_empty():
		return
	var message = JSON.parse_string(str(args[0]))
	if not message is Dictionary:
		return
	var id = message.get("id", -1)
	var command = str(message.get("command", ""))
	var options = message.get("args", {})
	if not options is Dictionary:
		options = {}
	match command:
		"play":
			_paused = false
			get_tree().paused = false
		"pause":
			_paused = true
			get_tree().paused = true
		"stop":
			_paused = true
			_reloading = true
			_selected_path = ""
			get_tree().paused = true
			var reload_result = get_tree().reload_current_scene()
			if reload_result != OK:
				_reloading = false
				_emit({"type": "error", "id": id, "error": "Scene reload failed."})
				return
			# Scene replacement is deferred; acknowledge only the new ready scene.
			while get_tree().current_scene == null or not get_tree().current_scene.is_node_ready():
				await get_tree().process_frame
			_reloading = false
		"stepFrame":
			if _paused:
				get_tree().paused = false
				await get_tree().process_frame
				await get_tree().process_frame
				get_tree().paused = true
		"select":
			_selected_path = str(options.get("path", ""))
		"inspect":
			var node = get_node_or_null(NodePath(str(options.get("path", ""))))
			_emit({"type": "response", "id": id, "data": _inspect(node)})
			return
		"camera":
			var node = get_node_or_null(NodePath(str(options.get("path", ""))))
			if node is Camera3D:
				node.current = true
			elif node is Camera2D:
				node.make_current()
			else:
				_emit({"type": "error", "id": id, "error": "Select a Camera2D or Camera3D."})
				return
		"overlay":
			var name = str(options.get("name", ""))
			if not _overlays.has(name):
				_emit({"type": "error", "id": id, "error": "Unknown overlay."})
				return
			_emit({"type": "error", "id": id, "error": "This overlay requires a runtime-specific provider."})
			return
		"state":
			pass
		_:
			_emit({"type": "error", "id": id, "error": "Unknown Viewer command."})
			return
	_send_state()
	_emit({"type": "response", "id": id, "data": {"ok": true}})

func _inspect(node: Node) -> Dictionary:
	if node == null:
		return {"error": "Node unavailable."}
	var properties := {}
	for property in node.get_property_list():
		if not (int(property.get("usage", 0)) & PROPERTY_USAGE_EDITOR):
			continue
		var key = str(property.get("name", ""))
		if properties.size() >= 48:
			break
		var value = node.get(key)
		if value is bool or value is int or value is float or value is String or value is Vector2 or value is Vector3:
			properties[key] = str(value)
	return {"path": str(node.get_path()), "name": node.name, "class": node.get_class(), "properties": properties}

func _tree(node: Node, depth := 0) -> Dictionary:
	var children := []
	if depth < 8:
		for child in node.get_children():
			if children.size() >= 100:
				break
			children.append(_tree(child, depth + 1))
	return {"path": str(node.get_path()), "name": node.name, "class": node.get_class(), "children": children}

func _send_state() -> void:
	if _reloading:
		return
	var scene = get_tree().current_scene
	_emit({"type": "state", "data": {"scene": scene.name if scene else "No scene", "tree": _tree(scene) if scene else null, "paused": _paused, "selectedPath": _selected_path, "overlays": _overlays}})

func _emit(message: Dictionary) -> void:
	if OS.has_feature("web"):
		var bridge = JavaScriptBridge.get_interface("HarnessGodotBridge")
		if bridge != null:
			bridge.emit(JSON.stringify(message))
