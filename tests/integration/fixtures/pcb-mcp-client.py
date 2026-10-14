import asyncio
import hashlib
import json
from pathlib import Path
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def data(result):
    return result.structuredContent or json.loads(result.content[0].text)


async def main():
    config_file = Path(sys.argv[1])
    config = json.loads(config_file.read_text())["mcpServers"]["pcb-design.tools"]
    mode = sys.argv[2] if len(sys.argv) > 2 else "fixture"
    async with stdio_client(StdioServerParameters(**config)) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            assert {t.name for t in (await session.list_tools()).tools} == {"domain_tool_list", "domain_tool_describe", "domain_tool_call", "domain_tool_result_read"}
            available = data(await session.call_tool("domain_tool_list", {"limit": 2}))
            ids = [t["toolId"] for t in available["tools"]]
            offset = available["nextOffset"]
            while offset is not None:
                page = data(await session.call_tool("domain_tool_list", {"offset": offset, "limit": 2}))
                ids += [t["toolId"] for t in page["tools"]]
                offset = page["nextOffset"]
            assert "pcb.design.run_python" not in ids
            for tool, arguments in [
                ("domain_tool_describe", {"toolId": "pcb.design.run_python"}),
                ("domain_tool_call", {"toolId": "pcb.design.run_python", "arguments": {"code": "raise Exception()"}}),
                ("domain_tool_call", {"toolId": "pcb.design.project_status", "arguments": {"project_path": "/another-project"}}),
                ("domain_tool_call", {"toolId": "pcb.design.project_status", "arguments": {"approval": True}}),
                ("domain_tool_result_read", {"responseId": "../another-session"}),
            ]:
                assert (await session.call_tool(tool, arguments)).isError
            described = data(await session.call_tool("domain_tool_describe", {"toolId": "pcb.design.project_status"}))
            assert described["nativeName"] == "project_status"
            if mode == "source":
                assert (await session.call_tool("domain_tool_call", {"toolId": "pcb.design.inspect_tool", "arguments": {"name": "run_python"}})).isError
                # The real upstream source may advertise tools on the host, but
                # must refuse execution without its root-owned controller lease.
                result = await session.call_tool("domain_tool_call", {"toolId": "pcb.design.project_status"})
                assert result.isError
                assert "controller" in json.dumps(data(result)).lower(), json.dumps(data(result))
                print(json.dumps({"ok": True, "realSourceSchema": True, "hostExecutionRejected": True, "tools": len(ids)}))
                return
            created = data(await session.call_tool("domain_tool_call", {"toolId": "pcb.design.new_project", "arguments": {"width_mm": 20, "height_mm": 15}}))
            assert created["result"]["status"] == "MODIFIED"
            typed = await session.call_tool("domain_tool_call", {"toolId": "pcb.design.finalize_claims", "argumentsJson": '{"completed":true,"remaining_issues":["fixture"]}'})
            assert not typed.isError
            for bad in [
                {"toolId": "pcb.design.finalize_claims", "argumentsJson": '{"completed":"true","remaining_issues":{"item":"fixture"}}'},
                {"toolId": "pcb.design.finalize_claims", "argumentsJson": '[true]'},
                {"toolId": "pcb.design.finalize_claims", "argumentsJson": '{"completed":true,"completed":false,"remaining_issues":[]}'},
                {"toolId": "pcb.design.finalize_claims", "argumentsJson": '{"completed":NaN,"remaining_issues":[]}'},
                {"toolId": "pcb.design.finalize_claims", "arguments": {}, "argumentsJson": '{}'},
            ]:
                assert (await session.call_tool("domain_tool_call", bad)).isError
            observed = data(await session.call_tool("domain_tool_call", {"toolId": "pcb.design.project_status"}))
            assert observed["result"]["spec"] == {"width_mm": 20, "height_mm": 15}
            check = await session.call_tool("domain_tool_call", {"toolId": "pcb.design.run_drc"})
            assert not check.isError and data(check)["result"]["status"] == "FAIL", "check FAIL is distinct from transport failure"
            image = await session.call_tool("domain_tool_call", {"toolId": "pcb.design.view_design"})
            image_enabled = mode == "vision"
            assert any(block.type == "image" for block in image.content) == image_enabled
            assert data(image)["images"][0]["delivered"] == image_enabled
            large = data(await session.call_tool("domain_tool_call", {"toolId": "pcb.design.inspect_tool", "arguments": {"name": "project_status"}}))
            assert large["paged"]
            chunks, offset = [], 0
            while offset is not None:
                page = data(await session.call_tool("domain_tool_result_read", {"responseId": large["responseId"], "offset": offset}))
                assert len(json.dumps(page, ensure_ascii=False).encode()) <= 16 * 1024
                chunks.append(page["text"])
                offset = page["nextOffset"]
            raw = "".join(chunks)
            assert hashlib.sha256(raw.encode()).hexdigest() == large["sha256"]
            assert json.loads(raw)["result"]["text"] == "完整报告\n\t" * 12000
            print(json.dumps({"ok": True, "scope": True, "persistentFixture": True, "checkFailPreserved": True, "images": image_enabled, "paging": True}))


asyncio.run(main())
