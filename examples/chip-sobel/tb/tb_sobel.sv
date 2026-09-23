// SPDX-License-Identifier: MIT
//
// tb_sobel: self-checking testbench for sobel_top.
//
// - Drives the generated test cases (ref/gen_vectors.py -> tb_vectors.svh)
//   as back-to-back frames with per-frame configuration changes and
//   randomized in_valid stalls.
// - Samples the output stream on the negative clock edge and compares every
//   pixel, frame_start and frame_end flag against the independent reference
//   model output, proving value correctness, exact frame sizes, ordering
//   (sequence compare) and no loss/duplication.
// - Any mismatch aborts with $fatal (a "%Error" line); a clean run ends with
//   "TEST PASSED" and $finish.

`timescale 1ns / 1ps
`default_nettype none

module tb_sobel;

    localparam int CLK_HALF_NS = 5;  // 10 ns period = 100 MHz

    logic        clk = 1'b0;
    logic        rst_n = 1'b0;
    logic [7:0]  cfg_width = 8'd3;
    logic [15:0] cfg_height = 16'd3;
    logic [7:0]  cfg_threshold = 8'd0;
    logic        in_valid = 1'b0;
    wire         in_ready;
    logic [7:0]  in_pixel = 8'd0;
    wire         out_valid;
    wire [7:0]   out_pixel;
    wire         out_frame_start;
    wire         out_frame_end;

    `include "tb_vectors.svh"

    sobel_top dut (
        .clk(clk),
        .rst_n(rst_n),
        .cfg_width(cfg_width),
        .cfg_height(cfg_height),
        .cfg_threshold(cfg_threshold),
        .in_valid(in_valid),
        .in_ready(in_ready),
        .in_pixel(in_pixel),
        .out_valid(out_valid),
        .out_pixel(out_pixel),
        .out_frame_start(out_frame_start),
        .out_frame_end(out_frame_end)
    );

    always #(CLK_HALF_NS) clk = ~clk;

    // ------------------------------------------------------------------
    // Stimulus: frames back-to-back, random input stalls
    // ------------------------------------------------------------------
    initial begin
        repeat (5) @(negedge clk);
        rst_n = 1'b1;
        @(negedge clk);
        for (int cs = 0; cs < N_CASES; cs++) begin
            cfg_width     = case_w[cs][7:0];
            cfg_height    = case_h[cs][15:0];
            cfg_threshold = case_thr[cs][7:0];
            for (int i = 0; i < case_len[cs]; i++) begin
                // random bubble before the pixel (in_valid is low here)
                repeat ($urandom_range(2, 0)) @(negedge clk);
                in_valid = 1'b1;
                in_pixel = stim_in[case_off[cs] + i];
                // in_ready sampled mid-cycle is the value used at the next
                // posedge; while it is low the pixel is not accepted.
                while (!in_ready) @(negedge clk);
                // accepted at the upcoming posedge; hold valid until after it
                @(negedge clk);
                in_valid = 1'b0;
            end
            // random inter-frame gap
            repeat ($urandom_range(4, 1)) @(negedge clk);
        end
    end

    // ------------------------------------------------------------------
    // Monitor / scoreboard
    // ------------------------------------------------------------------
    int out_case = 0;
    int out_idx  = 0;
    int out_seen = 0;

    always @(negedge clk) begin
        if (rst_n && out_valid) begin
            automatic int len = case_len[out_case];
            automatic logic [7:0] exp = exp_out[case_off[out_case] + out_idx];
            if (out_pixel !== exp)
                $fatal(1, "MISMATCH case %0d pixel %0d: got %0d expected %0d",
                       out_case, out_idx, out_pixel, exp);
            if (out_frame_start !== (out_idx == 0))
                $fatal(1, "frame_start error case %0d pixel %0d", out_case, out_idx);
            if (out_frame_end !== (out_idx == len - 1))
                $fatal(1, "frame_end error case %0d pixel %0d", out_case, out_idx);
            out_seen++;
            out_idx++;
            if (out_idx == len) begin
                out_idx = 0;
                out_case++;
                if (out_case == N_CASES) begin
                    $display("TEST PASSED: %0d cases, %0d output pixels checked",
                             N_CASES, out_seen);
                    $finish;
                end
            end
        end
    end

    // ------------------------------------------------------------------
    // Watchdog
    // ------------------------------------------------------------------
    initial begin
        #20000000;  // 20 ms >> expected runtime
        $fatal(1, "TIMEOUT waiting for outputs (case %0d pixel %0d)", out_case, out_idx);
    end

endmodule

`default_nettype wire
