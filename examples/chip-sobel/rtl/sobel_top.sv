// SPDX-License-Identifier: MIT
//
// sobel_top: streaming 3x3 Sobel edge-detection image filter.
//
// - 8-bit grayscale pixels in raster order, valid/ready input handshake.
// - Gradient magnitude |Gx| + |Gy|, binarized against a per-frame threshold:
//   magnitude >= threshold -> 255, else 0.
// - Output size equals input size; the outermost pixel ring is always 0.
// - Output stream: valid + frame_start/frame_end markers; downstream is
//   always ready. Idle cycles are allowed; pixels are never lost,
//   duplicated or reordered.
// - Per-frame configuration cfg_width/cfg_height/cfg_threshold is sampled
//   at the first accepted pixel of each frame.
// - Single clock, synchronous active-low reset.
// - Two line buffers (no full-frame buffering) form the sliding window.

`default_nettype none

module sobel_top (
    input  wire        clk,
    input  wire        rst_n,          // synchronous, active low
    // per-frame configuration
    input  wire [7:0]  cfg_width,      // 3..128
    input  wire [15:0] cfg_height,     // 3..65535
    input  wire [7:0]  cfg_threshold,
    // streaming input (valid/ready)
    input  wire        in_valid,
    output wire        in_ready,
    input  wire [7:0]  in_pixel,
    // streaming output (downstream always ready)
    output wire        out_valid,
    output wire [7:0]  out_pixel,
    output wire        out_frame_start,
    output wire        out_frame_end
);

    localparam int MAX_W      = 128;  // line buffer capacity (pixels)
    localparam int DATA_DEPTH = 8;    // result FIFO entries
    localparam int CFG_DEPTH  = 4;    // pending frame-config entries

    // ------------------------------------------------------------------
    // Line buffers (row r-2 and row r-1) and 3x3 window shift chains
    // ------------------------------------------------------------------
    reg [7:0] lb0 [0:MAX_W-1];
    reg [7:0] lb1 [0:MAX_W-1];

    // Two-stage chains: at consume (r,c), t2 holds lb0[c-1], t1 holds lb0[c-2].
    reg [7:0] t1, t2;  // top row taps (row r-2)
    reg [7:0] m1, m2;  // middle row taps (row r-1)
    reg [7:0] b1, b2;  // bottom row taps (row r, current input row)

    // ------------------------------------------------------------------
    // Input-side state
    // ------------------------------------------------------------------
    reg        in_active;             // a frame is being consumed
    reg [7:0]  in_c;                  // column of next pixel to consume
    reg [15:0] in_r;                  // row of next pixel to consume
    reg [7:0]  width_q;               // active frame config
    reg [15:0] height_q;
    reg [7:0]  thr_q;

    // ------------------------------------------------------------------
    // Result FIFO (interior pixels, raster push order == raster pop order)
    // ------------------------------------------------------------------
    reg [7:0] data_q [0:DATA_DEPTH-1];
    reg [2:0] data_wr;
    reg [2:0] data_rd;
    reg [3:0] data_count;

    // ------------------------------------------------------------------
    // Frame-config FIFO {width, height} for the output sequencer
    // ------------------------------------------------------------------
    reg [7:0]  cfg_w_q [0:CFG_DEPTH-1];
    reg [15:0] cfg_h_q [0:CFG_DEPTH-1];
    reg [1:0]  cfg_wr;
    reg [1:0]  cfg_rd;
    reg [2:0]  cfg_count;

    // ------------------------------------------------------------------
    // Input handshake
    // ------------------------------------------------------------------
    wire data_nearly_full = (data_count >= 4'd6);  // >= DEPTH-2
    wire cfg_full         = (cfg_count == 3'd4);   // == CFG_DEPTH
    assign in_ready = rst_n && !data_nearly_full && !cfg_full;
    wire consume = in_valid && in_ready;

    wire [7:0]  cur_w = in_active ? width_q  : cfg_width;
    wire [15:0] cur_h = in_active ? height_q : cfg_height;
    wire last_col = (in_c == cur_w - 8'd1);
    wire last_row = (in_r == cur_h - 16'd1);

    // ------------------------------------------------------------------
    // Window formation: at consume (r,c) the window centered at output
    // pixel (r-1,c-1) is complete.
    // ------------------------------------------------------------------
    wire [7:0] lb0_d = lb0[in_c[6:0]];
    wire [7:0] lb1_d = lb1[in_c[6:0]];

    wire [7:0] p00 = t1;
    wire [7:0] p01 = t2;
    wire [7:0] p02 = lb0_d;
    wire [7:0] p10 = m1;
    wire [7:0] p11 = m2;
    wire [7:0] p12 = lb1_d;
    wire [7:0] p20 = b1;
    wire [7:0] p21 = b2;
    wire [7:0] p22 = in_pixel;

    // ------------------------------------------------------------------
    // Sobel gradients and threshold compare (combinational, one cycle)
    // ------------------------------------------------------------------
    wire [10:0] col_l = {3'b000, p00} + {2'b00, p10, 1'b0} + {3'b000, p20};
    wire [10:0] col_r = {3'b000, p02} + {2'b00, p12, 1'b0} + {3'b000, p22};
    wire [10:0] row_t = {3'b000, p00} + {2'b00, p01, 1'b0} + {3'b000, p02};
    wire [10:0] row_b = {3'b000, p20} + {2'b00, p21, 1'b0} + {3'b000, p22};

    wire signed [11:0] gx = $signed({1'b0, col_r}) - $signed({1'b0, col_l});
    wire signed [11:0] gy = $signed({1'b0, row_b}) - $signed({1'b0, row_t});
    wire [11:0] abs_gx = gx[11] ? ~gx + 12'd1 : gx;
    wire [11:0] abs_gy = gy[11] ? ~gy + 12'd1 : gy;
    wire [11:0] mag = abs_gx + abs_gy;

    wire [7:0] sobel_bin = (mag >= {4'b0000, thr_q}) ? 8'hFF : 8'h00;

    wire push = consume && (in_r >= 16'd2) && (in_c >= 8'd2);

    // ------------------------------------------------------------------
    // Output sequencer: strict raster order; borders emit 0 without
    // popping, interior pixels pop one result each.
    // ------------------------------------------------------------------
    reg        out_active;
    reg [7:0]  out_w;
    reg [15:0] out_h;
    reg [7:0]  out_c;
    reg [15:0] out_r;

    wire out_last_col = (out_c == out_w - 8'd1);
    wire out_last_row = (out_r == out_h - 16'd1);
    wire out_border = (out_c == 8'd0) || out_last_col ||
                      (out_r == 16'd0) || out_last_row;
    wire out_can = out_active && (out_border || (data_count != 4'd0));
    wire pop = out_can && !out_border;

    assign out_valid       = out_can;
    assign out_pixel       = out_border ? 8'h00 : data_q[data_rd];
    assign out_frame_start = out_can && (out_r == 16'd0) && (out_c == 8'd0);
    assign out_frame_end   = out_can && out_last_row && out_last_col;

    wire cfg_push = consume && !in_active;
    wire cfg_pop  = !out_active && (cfg_count != 3'd0);

    // ------------------------------------------------------------------
    // Sequential logic (single clock, synchronous active-low reset)
    // ------------------------------------------------------------------
    always @(posedge clk) begin
        if (!rst_n) begin
            in_active <= 1'b0;
            in_c      <= 8'd0;
            in_r      <= 16'd0;
            width_q   <= 8'd3;
            height_q  <= 16'd3;
            thr_q     <= 8'd0;
            t1 <= 8'd0; t2 <= 8'd0;
            m1 <= 8'd0; m2 <= 8'd0;
            b1 <= 8'd0; b2 <= 8'd0;
            data_wr    <= 3'd0;
            data_rd    <= 3'd0;
            data_count <= 4'd0;
            cfg_wr    <= 2'd0;
            cfg_rd    <= 2'd0;
            cfg_count <= 3'd0;
            out_active <= 1'b0;
            out_w      <= 8'd3;
            out_h      <= 16'd3;
            out_c      <= 8'd0;
            out_r      <= 16'd0;
        end else begin
            // ---------------- input side ----------------
            if (consume) begin
                if (!in_active) begin
                    in_active <= 1'b1;
                    width_q   <= cfg_width;
                    height_q  <= cfg_height;
                    thr_q     <= cfg_threshold;
                    cfg_w_q[cfg_wr] <= cfg_width;
                    cfg_h_q[cfg_wr] <= cfg_height;
                    cfg_wr <= cfg_wr + 2'd1;
                end
                lb0[in_c[6:0]] <= lb1_d;
                lb1[in_c[6:0]] <= in_pixel;
                t1 <= t2; t2 <= lb0_d;
                m1 <= m2; m2 <= lb1_d;
                b1 <= b2; b2 <= in_pixel;
                if (push) begin
                    data_q[data_wr] <= sobel_bin;
                    data_wr <= data_wr + 3'd1;
                end
                if (last_col) begin
                    in_c <= 8'd0;
                    if (last_row) begin
                        in_r      <= 16'd0;
                        in_active <= 1'b0;
                    end else begin
                        in_r <= in_r + 16'd1;
                    end
                end else begin
                    in_c <= in_c + 8'd1;
                end
            end

            // ---------------- output side ----------------
            if (cfg_pop) begin
                out_active <= 1'b1;
                out_w      <= cfg_w_q[cfg_rd];
                out_h      <= cfg_h_q[cfg_rd];
                out_c      <= 8'd0;
                out_r      <= 16'd0;
                cfg_rd     <= cfg_rd + 2'd1;
            end else if (out_can) begin
                if (pop) begin
                    data_rd <= data_rd + 3'd1;
                end
                if (out_last_col) begin
                    out_c <= 8'd0;
                    if (out_last_row) begin
                        out_r      <= 16'd0;
                        out_active <= 1'b0;
                    end else begin
                        out_r <= out_r + 16'd1;
                    end
                end else begin
                    out_c <= out_c + 8'd1;
                end
            end

            // ---------------- FIFO occupancy ----------------
            if (push && !pop)
                data_count <= data_count + 4'd1;
            else if (!push && pop)
                data_count <= data_count - 4'd1;

            if (cfg_push && !cfg_pop)
                cfg_count <= cfg_count + 3'd1;
            else if (!cfg_push && cfg_pop)
                cfg_count <= cfg_count - 3'd1;

            // ---------------- invariants (simulation only) ----------------
            if (push && !pop)
                assert (data_count < DATA_DEPTH[3:0])
                    else $error("sobel_top: data FIFO overflow");
            if (pop)
                assert (data_count != 4'd0)
                    else $error("sobel_top: data FIFO underflow");
            if (cfg_push && !cfg_pop)
                assert (cfg_count < CFG_DEPTH[2:0])
                    else $error("sobel_top: config FIFO overflow");
        end
    end

endmodule

`default_nettype wire
