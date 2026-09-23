# Sobel filter timing constraints, Nangate45 typical corner.
# Target: 100 MHz (10.000 ns period).

create_clock -name core_clk -period 10.000 [get_ports clk]

set_clock_uncertainty -setup 0.150 [get_clocks core_clk]
set_clock_uncertainty -hold 0.050 [get_clocks core_clk]

set input_pins [remove_from_collection [all_inputs] [get_ports clk]]
set_input_delay -clock core_clk 2.000 $input_pins
set_output_delay -clock core_clk 2.000 [all_outputs]

set_driving_cell -lib_cell BUF_X1 $input_pins
set_load 0.050 [all_outputs]
