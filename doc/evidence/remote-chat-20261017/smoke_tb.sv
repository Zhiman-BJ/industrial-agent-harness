`timescale 1ns/1ps
module smoke_tb;
  logic clk = 0;
  logic [3:0] count = 0;
  always #5 clk = ~clk;
  always @(posedge clk) count <= count + 1;
  initial begin
    $dumpfile("wave.vcd");
    $dumpvars(0, smoke_tb);
    #41;
    assert (count == 4) else $fatal(1, "counter mismatch");
    $display("HARNESS_REMOTE_SMOKE_PASS");
    $finish;
  end
endmodule
